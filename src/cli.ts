#!/usr/bin/env node

/**
 * WDK Bundle CLI
 */

import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { DEFAULT_BUNDLE_BUILD_HOSTS, DEFAULT_BUNDLE_PATH, DEFAULT_TYPES_PATH, DEFAULT_OUTPUT_DIR } from './constants'
import { printBanner } from './utils/banner'
import type { WdkBundleConfig } from './config/types'
import pkg from '../package.json'

interface GenerateOptions {
  config?: string
  install?: boolean
  keepArtifacts?: boolean
  dryRun?: boolean
  verbose?: boolean
  types?: boolean
  sourceOnly?: boolean
  skipGeneration?: boolean
}

interface InitOptions {
  yes?: boolean
}

interface ValidateOptions {
  config?: string
}

interface ListModulesOptions {
  json?: boolean
}

interface CleanOptions {
  yes?: boolean
}

const program = new Command()

program.name('wdk-worklet-bundler').description('CLI tool for generating WDK worklet bundles').version(pkg.version)

function getPackageList (config: WdkBundleConfig): string[] {
  const packages = new Set<string>()

  // Add core (always required implicitly, unless overriden/preloaded logic changes)
  // For validation, we should probably check it.
  packages.add('@tetherto/wdk')
  packages.add('bare-node-runtime')

  if (config.networks) {
    for (const net of Object.values(config.networks)) {
      if (net.package) packages.add(net.package)
    }
  }

  if (config.protocols != null) {
    for (const protocol of Object.values(config.protocols)) {
      if (protocol?.package) packages.add(protocol.package)
    }
  }

  if (config.preloadModules != null) {
    for (const mod of config.preloadModules) {
      packages.add(mod)
    }
  }

  return Array.from(packages)
}

program
  .command('generate')
  .description('Generate WDK bundle from configuration')
  .option('-c, --config <path>', 'Path to config file')
  .option('--install', 'Auto-install missing dependencies')
  .option('--keep-artifacts', 'Keep intermediate generated files (useful for debugging)')
  .option('--dry-run', 'Show what would be generated without building')
  .option('-v, --verbose', 'Show verbose output')
  .option('--no-types', 'Skip TypeScript declaration generation')
  .option('--source-only', 'Only generate source files (skip bare-pack)')
  .option('--skip-generation', 'Skip artifact generation and use existing files')
  .action(async (options: GenerateOptions) => {
    const { loadConfig } = await import('./config/loader')
    const {
      validateDependencies,
      installDependencies,
      checkOptionalPeerDependencies
    } = await import('./validators/dependencies')
    const { generateBundle, generateSourceFiles } = await import('./bundler')

    // Track packages installed by --install for potential cleanup
    const installedPackages: string[] = []

    // Helper for prompts
    const promptYesNo = async (question: string): Promise<boolean> => {
      const readline = await import('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      return await new Promise((resolve) => {
        rl.question(`${question} [Y/n] `, (answer) => {
          rl.close()
          resolve(answer.toLowerCase() !== 'n')
        })
      })
    }

    try {
      console.log('\n🔍 Reading configuration...\n')
      const config = await loadConfig(options.config)
      console.log(`  Config: ${config.configPath}`)

      console.log('\n📦 Checking core dependencies...\n')
      const requiredPackages = getPackageList(config)
      let validation = validateDependencies(requiredPackages, config.projectRoot)

      for (const mod of validation.installed) {
        const version = mod.isLocal ? 'local' : `v${mod.version}`
        console.log(`  ✓ ${mod.name} (${version})`)
      }
      for (const mod of validation.missing) {
        console.log(`  ✗ ${mod} — NOT INSTALLED`)
      }

      if (!validation.valid) {
        let shouldInstall = options.install

        if (!shouldInstall && !options.sourceOnly) {
          console.log('\n⚠️  Missing core dependencies.')
          shouldInstall = await promptYesNo('Would you like to install them now?')
        }

        if (shouldInstall) {
          console.log('\n📥 Installing missing dependencies...\n')
          const result = installDependencies(validation.missing, config.projectRoot, {
            verbose: options.verbose
          })

          if (result.success) {
            installedPackages.push(...result.installed)
            validation = validateDependencies(requiredPackages, config.projectRoot)
          } else {
            console.log(`\n❌ Failed to install: ${result.error || 'Unknown error'}`)
            process.exit(1)
          }
        } else if (!options.sourceOnly) {
          console.log('\n❌ Cannot proceed without core dependencies.')
          process.exit(1)
        }
      }

      if (validation.valid && !options.sourceOnly) {
        const missingPeers = checkOptionalPeerDependencies(validation.installed, config.projectRoot, {
          verbose: options.verbose
        })

        if (missingPeers.length > 0) {
          console.log('\n🧩 Checking peer dependencies...\n')
          console.log('  The following optional peer dependencies were found in your dependency tree.')
          console.log('  They are likely required for the worklet bundle to function correctly.\n')

          const packagesToInstall: string[] = []

          for (const peer of missingPeers) {
            // Determine install version
            const ranges = [...new Set(peer.sources.map(s => s.range))]
            const isSingle = ranges.length === 1

            if (isSingle) {
              // Single consistent requirement
              console.log(`  ? ${peer.name}@${ranges[0]}`)
              packagesToInstall.push(`${peer.name}@${ranges[0]}`)

              for (const source of peer.sources) {
                console.log(`    └─ required by ${source.parent}`)
              }
            } else {
              // Conflicting or mixed requirements
              console.log(`  ? ${peer.name} (mixed requirements)`)
              console.log('    ⚠️  Falling back to latest')
              packagesToInstall.push(peer.name)

              for (const source of peer.sources) {
                console.log(`    └─ required by ${source.parent} @ ${source.range}`)
              }
            }
          }

          let shouldInstallPeers = options.install

          if (!shouldInstallPeers) {
            console.log('\n⚠️  Missing optional peer dependencies.')
            shouldInstallPeers = await promptYesNo('Would you like to install them now?')
          }

          if (shouldInstallPeers) {
            console.log('\n📥 Installing peer dependencies...\n')
            const result = installDependencies(packagesToInstall, config.projectRoot, {
              verbose: options.verbose
            })

            if (result.success) {
              installedPackages.push(...result.installed)
            } else {
              console.log(`\n⚠️  Warning: Failed to install some peer dependencies: ${result.error}`)
            }
          }
        }
      }

      console.log('\n🌐 Networks configured:\n')
      for (const [name, cfg] of Object.entries(config.networks)) {
        console.log(`  ├── ${name} (${cfg.package})`)
      }

      if (options.sourceOnly) {
        console.log('\n🔧 Generating source files (source-only mode)...\n')

        const result = await generateSourceFiles(config, {
          verbose: options.verbose
        })

        console.log('\n✅ Source files generated successfully!\n')
        console.log(`  Entry: ${result.entryPath}`)
        console.log('Run bare-pack manually to create the final bundle.\n')
        return
      }

      console.log('\n🔧 Building bundle...\n')

      const result = await generateBundle(config, {
        dryRun: options.dryRun,
        verbose: options.verbose,
        skipTypes: !options.types,
        skipGeneration: options.skipGeneration
      })

      if (!result.success) {
        if (result.missingModule) {
          console.log(`\n❌ Build failed: Missing dependency '${result.missingModule}'\n`)
          console.log('💡 This appears to be a required dependency that was not detected automatically.')
          console.log('   Please install it manually and try again:\n')
          console.log(`   npm install ${result.missingModule}\n`)
          process.exit(1)
        }

        console.log('\n❌ Bundle generation failed:\n')
        console.log(result.error)
        process.exit(1)
      }

      const sizeKB = (result.bundleSize / 1024).toFixed(1)
      const duration = (result.duration / 1000).toFixed(2)

      console.log('\n✅ Bundle generated successfully!\n')
      console.log(`  Bundle: ${result.bundlePath} (${sizeKB} KB)`)
      if (options.types !== false) {
        console.log(`  Types: ${result.typesPath}`)
      }
      console.log(`  Duration: ${duration}s\n`)

      // Cleanup intermediate files unless --keep-artifacts is set
      if (!options.keepArtifacts) {
        if (options.verbose) console.log('🧹 Cleaning up intermediate files...\n')

        const generatedDir = path.join(config.projectRoot, DEFAULT_OUTPUT_DIR)

        if (fs.existsSync(generatedDir)) {
          try {
            fs.rmSync(generatedDir, { recursive: true, force: true })
            if (options.verbose) console.log(`  ✓ Removed ${generatedDir}\n`)
          } catch (e) {
            console.log(`  ⚠️  Failed to cleanup ${generatedDir}: ${String(e)}\n`)
          }
        }
      } else {
        console.log(`ℹ️  Keeping intermediate files in ${DEFAULT_OUTPUT_DIR}\n`)
      }
    } catch (error) {
      console.error('\n❌ Error:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

program
  .command('init')
  .description('Create a new wdk.config.js file')
  .option('-y, --yes', 'Use defaults without prompting')
  .action((options: InitOptions) => {
    const configPath = path.join(process.cwd(), 'wdk.config.js')

    if (fs.existsSync(configPath) && !options.yes) {
      console.log('\n⚠️  wdk.config.js already exists.\n')
      console.log('  Use --yes to overwrite.\n')
      process.exit(1)
    }

    const defaultNetworks = {
      ethereum: {
        package: '@tetherto/wdk-wallet-evm-erc-4337'
      }
    }

    const configContent = generateConfigTemplate(defaultNetworks, [])
    fs.writeFileSync(configPath, configContent)

    console.log('\n✅ Created wdk.config.js\n')
    console.log('  Edit the file to configure your networks and modules.\n')
  })

program
  .command('validate')
  .description('Validate configuration without building')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options: ValidateOptions) => {
    const { loadConfig } = await import('./config/loader')
    const { validateDependencies } = await import('./validators/dependencies')

    try {
      console.log('\n🔍 Validating configuration...\n')

      const config = await loadConfig(options.config)
      console.log(`  ✓ Config file valid: ${config.configPath}`)

      const requiredPackages = getPackageList(config)
      const validation = validateDependencies(requiredPackages, config.projectRoot)

      console.log('\n📦 Dependencies:\n')
      for (const mod of validation.installed) {
        console.log(`  ✓ ${mod.name}`)
      }
      for (const mod of validation.missing) {
        console.log(`  ✗ ${mod} — NOT INSTALLED`)
      }

      if (validation.valid) {
        console.log('\n✅ Configuration is valid and ready to build!\n')
      } else {
        console.log('\n⚠️  Missing dependencies. Install them before building.\n')
        process.exit(1)
      }
    } catch (error) {
      console.error('\n❌ Validation failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

program
  .command('list-modules')
  .description('List available WDK modules')
  .option('--json', 'Output as JSON')
  .action((options: ListModulesOptions) => {
    const modules = [
      { name: '@tetherto/wdk', description: 'WDK Core', required: true },
      { name: '@tetherto/wdk-wallet-evm', description: 'EVM chains (EOA)' },
      { name: '@tetherto/wdk-wallet-evm-erc-4337', description: 'EVM with Account Abstraction' },
      { name: '@tetherto/wdk-wallet-btc', description: 'Bitcoin' },
      { name: '@tetherto/wdk-wallet-spark', description: 'Spark (Lightning)' },
      { name: '@tetherto/wdk-wallet-ton', description: 'TON' },
      { name: '@tetherto/wdk-wallet-solana', description: 'Solana' }
    ]

    if (options.json) {
      console.log(JSON.stringify(modules, null, 2))
      return
    }

    console.log('\n📦 Available WDK Modules\n')
    for (const mod of modules) {
      const badge = mod.required ? ' [required]' : ''
      console.log(`  ${mod.name}${badge}`)
      console.log(`    ${mod.description}\n`)
    }
  })

program
  .command('clean')
  .description('Remove generated .wdk folder')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options: CleanOptions) => {
    const wdkDir = path.join(process.cwd(), DEFAULT_OUTPUT_DIR)

    if (!fs.existsSync(wdkDir)) {
      console.log('\n✓ Nothing to clean - .wdk folder does not exist\n')
      return
    }

    if (!options.yes) {
      const readline = await import('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      const answer = await new Promise<string>((resolve) => {
        rl.question('\n⚠️  This will delete the .wdk folder. Continue? [y/N] ', resolve)
      })
      rl.close()

      if (answer.toLowerCase() !== 'y') {
        console.log('\n  Cancelled.\n')
        return
      }
    }

    try {
      fs.rmSync(wdkDir, { recursive: true, force: true })
      console.log('\n✓ Removed .wdk folder\n')
    } catch (error) {
      console.error('\n❌ Failed to remove .wdk folder:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

function generateConfigTemplate (
  networks: Record<string, { package: string }>,
  preloadModules: string[]
): string {
  const networksStr = Object.entries(networks)
    .map(([key, value]) => {
      return `    ${key}: { package: '${value.package}' }`
    })
    .join(',\n')

  const preloadStr =
    preloadModules.length > 0 ? `  preloadModules: [\n    '${preloadModules.join("',\n    '")}'\n  ],\n` : ''

  return `/**
 * WDK Bundle Configuration
 * Generated by @tetherto/wdk-worklet-bundler
 *
 * For documentation see: https://github.com/tetherto/wdk-worklet-bundler
 */

module.exports = {
  // Network mappings
  // Map logical network names to WDK wallet packages
  networks: {
${networksStr}
  },

${preloadStr}  // Output paths (optional, defaults shown)
  output: {
    bundle: '${DEFAULT_BUNDLE_PATH}',
    types: '${DEFAULT_TYPES_PATH}'
  },

  // Build options (optional)
  options: {
    // minify: false,
    // sourceMaps: false,
    targets: ${JSON.stringify(DEFAULT_BUNDLE_BUILD_HOSTS)}
  }
};
`
}

if (process.argv.slice(2).length === 0) {
  printBanner()
  program.outputHelp()
}

program.parse()
