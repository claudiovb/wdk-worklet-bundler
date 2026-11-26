#!/usr/bin/env node

/**
 * WDK Bundle CLI
 */

import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { DEFAULT_OUTPUT_DIR, DEFAULT_PACKAGE_PATH, LEGACY_RUNTIME_PACKAGE, RUNTIME_OVERRIDE_SPEC } from './constants'
import { printBanner } from './utils/banner'
import { getPackageList } from './config/packages'
import type { WdkBundleConfig } from './config/types'
import pkg from '../package.json'

interface GenerateOptions {
  config?: string
  projectRoot?: string
  install?: boolean
  keepArtifacts?: boolean
  dryRun?: boolean
  verbose?: boolean
  sourceOnly?: boolean
  skipGeneration?: boolean
  transport?: string
  deferOptionalPeers?: boolean
}

interface InitOptions {
  yes?: boolean
}

interface ValidateOptions {
  config?: string
  projectRoot?: string
}

interface ListModulesOptions {
  json?: boolean
}

interface CleanOptions {
  yes?: boolean
}

const program = new Command()

program.name('wdk-worklet-bundler').description('CLI tool for generating WDK worklet packages').version(pkg.version)

program
  .command('generate')
  .description('Generate the WDK worklet package from configuration')
  .option('-c, --config <path>', 'Path to config file')
  .option('--project-root <dir>', 'Folder with the package.json and node_modules to build from (default: the folder of the config file)')
  .option('--install', 'Auto-install missing dependencies')
  .option('--keep-artifacts', 'Keep intermediate generated files (useful for debugging)')
  .option('--dry-run', 'Show what would be generated without building')
  .option('-v, --verbose', 'Show verbose output')
  .option('--source-only', 'Only generate source files (skip packing)')
  .option('--skip-generation', 'Skip artifact generation and use existing files')
  .option('--transport <transport>', 'Transport: bare-rpc or hrpc (replaces the value of the config file)')
  .option('--no-defer-optional-peers', 'Fail on missing optional peer deps (e.g. Ledger support) instead of deferring them to runtime')
  .action(async (options: GenerateOptions) => {
    const { loadConfig } = await import('./config/loader')
    const {
      validateDependencies,
      installDependencies,
      findMissingRequiredPeers,
      detectPackageManager,
      installablePackageRoot,
      generateInstallCommand,
      writeRuntimeOverride,
      toInstallSpec
    } = await import('./validators/dependencies')
    const { generateBundle, generateSourceFiles } = await import('./bundler')

    // Track packages installed by --install for potential cleanup
    const installedPackages: string[] = []

    // Helper for prompts. Without a TTY (npm postinstall, CI) readline's
    // callback never fires and node exits 0 silently, so answer with the
    // provided default instead of prompting.
    const promptYesNo = async (question: string, nonInteractiveDefault = false): Promise<boolean> => {
      if (!process.stdin.isTTY) {
        console.log(`${question} [Y/n] — non-interactive environment detected, assuming '${nonInteractiveDefault ? 'yes' : 'no'}'`)
        return nonInteractiveDefault
      }

      const readline = await import('readline')
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      return await new Promise((resolve) => {
        let answered = false
        rl.question(`${question} [Y/n] `, (answer) => {
          answered = true
          rl.close()
          resolve(answer.toLowerCase() !== 'n')
        })
        rl.on('close', () => {
          if (!answered) resolve(nonInteractiveDefault)
        })
      })
    }

    try {
      console.log('\n🔍 Reading configuration...\n')
      // --transport replaces the config file's value and is validated with it
      const config = await loadConfig(options.config, {
        transport: options.transport as WdkBundleConfig['transport'],
        projectRoot: options.projectRoot
      })
      console.log(`  Config: ${config.configPath}`)
      if (options.projectRoot !== undefined) console.log(`  Project root: ${config.projectRoot}`)

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

          // The override must be in package.json before the install resolves
          // the wallet packages' own bare-node-runtime dependency.
          if (writeRuntimeOverride(config.projectRoot)) {
            console.log(`  ✓ package.json: override ${LEGACY_RUNTIME_PACKAGE} → ${RUNTIME_OVERRIDE_SPEC}\n`)
          }

          const result = installDependencies(validation.missing.map(toInstallSpec), config.projectRoot, {
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
          console.log('   Install them manually or re-run with --install.\n')
          process.exit(1)
        }
      }

      if (validation.valid && !options.sourceOnly) {
        const missingRequiredPeers = findMissingRequiredPeers(validation.installed, config.projectRoot, {
          verbose: options.verbose
        })

        if (missingRequiredPeers.length > 0) {
          console.log('\n🧩 Checking peer dependencies...\n')
          console.log('  The following peer dependencies are missing from your dependency tree.')
          console.log('  They are likely required for the worklet bundle to function correctly.\n')

          const packagesToInstall: string[] = []

          for (const peer of missingRequiredPeers) {
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
            console.log('\n⚠️  Missing peer dependencies.')
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
          } else {
            const installCmd = generateInstallCommand(packagesToInstall, detectPackageManager(config.projectRoot))
            console.log('\n⚠️  Skipping peer dependency installation. If the bundle fails, install them manually:\n')
            console.log(`   ${installCmd}\n`)
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
        console.log('Run generate without --source-only to pack it.\n')
        return
      }

      console.log('\n🔧 Building package...\n')

      const result = await generateBundle(config, {
        dryRun: options.dryRun,
        verbose: options.verbose,
        skipGeneration: options.skipGeneration,
        deferOptionalPeers: options.deferOptionalPeers
      })

      if (!result.success) {
        if (result.missingModule) {
          console.log(`\n❌ Build failed: Missing dependency '${result.missingModule}'\n`)
          const installable = installablePackageRoot(result.missingModule)
          if (installable != null) {
            const installCommand = generateInstallCommand(
              [toInstallSpec(installable)],
              detectPackageManager(config.projectRoot)
            )
            console.log('💡 This appears to be a required dependency that was not detected automatically.')
            console.log('   Please install it manually and try again:\n')
            console.log(`   ${installCommand}\n`)
          }
          process.exit(1)
        }

        console.log('\n❌ Package generation failed:\n')
        console.log(result.error)
        process.exit(1)
      }

      // A dry run wrote nothing: there is no package to report or clean up.
      if (options.dryRun) return

      const sizeKB = (result.bundleSize / 1024).toFixed(1)
      const duration = (result.duration / 1000).toFixed(2)

      console.log('\n✅ Package generated successfully!\n')
      console.log(`  Package: ${result.outputDir} (${config.language}, ${config.transport}, ${result.files.length} files)`)
      console.log(`  Bundle: ${result.bundlePath} (${sizeKB} KB)`)
      console.log(`  Duration: ${duration}s\n`)

      // Cleanup intermediate files unless --keep-artifacts is set
      if (!options.keepArtifacts) {
        if (options.verbose) console.log('Cleaning up intermediate files...\n')
        const generatedDir = path.join(config.projectRoot, DEFAULT_OUTPUT_DIR)

        try {
          fs.rmSync(generatedDir, { recursive: true, force: true })
          if (options.verbose) console.log(`  ✓ Removed ${generatedDir}\n`)
        } catch (e) {
          console.log(`  ⚠️  Failed to cleanup ${generatedDir}: ${String(e)}\n`)
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
    console.log('  Edit the file to set the language and configure your networks and modules.\n')
  })

program
  .command('validate')
  .description('Validate configuration without building')
  .option('-c, --config <path>', 'Path to config file')
  .option('--project-root <dir>', 'Folder with the package.json and node_modules to check (default: the folder of the config file)')
  .action(async (options: ValidateOptions) => {
    const { loadConfig } = await import('./config/loader')
    const { validateDependencies } = await import('./validators/dependencies')

    try {
      console.log('\n🔍 Validating configuration...\n')

      const config = await loadConfig(options.config, { projectRoot: options.projectRoot })
      console.log(`  ✓ Config file valid: ${config.configPath}`)
      if (options.projectRoot !== undefined) console.log(`  Project root: ${config.projectRoot}`)

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
  // Transport the worklet serves: 'bare-rpc' or 'hrpc'
  transport: 'bare-rpc',

  // Required: language of the generated host package, 'swift' or 'kotlin'
  // language: '',

  // Kotlin package of the generated code (kotlin only)
  // kotlinPackage: 'to.tether.wdk.worklet',

  // Network mappings
  // Map logical network names to WDK wallet packages
  networks: {
${networksStr}
  },

${preloadStr}  // Folder of the generated package (optional, default shown).
  // The Swift module is named after it: wdk-worklet → WdkWorklet
  output: '${DEFAULT_PACKAGE_PATH}',

  // Build options (optional)
  options: {
    // Hosts to build for. Default: every host of the language
    // targets: ['ios-arm64', 'ios-arm64-simulator'],
    // Experimental: 'javascriptcore' (swift) or 'quickjs' (kotlin)
    // engine: 'v8',
  }
};
`
}

if (process.argv.slice(2).length === 0) {
  printBanner()
  program.outputHelp()
}

program.parse()
