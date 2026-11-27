import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { listFiles, readBundleFile, readStowedBundle, writeFixtureFile, writeStandInWdkProject } from '../helpers/stow-fixture'

const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js')

describe('CLI Integration Tests', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-cli-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const runCliIn = (cwd: string, args: string): string => {
    try {
      return execSync(`node ${CLI_PATH} ${args} 2>&1`, {
        encoding: 'utf-8',
        cwd
      })
    } catch (error: unknown) {
      const execError = error as { stdout?: string, stderr?: string, message?: string }
      return execError.stdout || execError.stderr || execError.message || ''
    }
  }

  const runCli = (args: string): string => runCliIn(tempDir, args)

  const mockPackage = (name: string): void => {
    const pkgPath = path.join(tempDir, 'node_modules', name)
    fs.mkdirSync(pkgPath, { recursive: true })
    fs.writeFileSync(
      path.join(pkgPath, 'package.json'),
      JSON.stringify({ name, version: '1.0.0' })
    )
  }

  describe('init command', () => {
    it('should create wdk.config.js with default config', () => {
      const output = runCli('init -y')

      expect(output).toContain('Created wdk.config.js')
      expect(fs.existsSync(path.join(tempDir, 'wdk.config.js'))).toBe(true)
    })

    it('should create a config that only lacks the language, which has no default', () => {
      runCli('init -y')

      const output = runCli('validate')

      expect(output).toContain("Validation failed: Invalid configuration:\n  - root: must have required property 'language'\n")
      expect(output).not.toContain('Config file valid')
    })

    it('should warn if config already exists', () => {
      runCli('init -y')
      const output = runCli('init')
      expect(output).toContain('already exists')
    })

    it('should overwrite with -y flag', () => {
      runCli('init -y')
      fs.appendFileSync(path.join(tempDir, 'wdk.config.js'), '// modified')
      runCli('init -y')
      const content = fs.readFileSync(path.join(tempDir, 'wdk.config.js'), 'utf-8')
      expect(content).not.toContain('// modified')
    })
  })

  describe('validate command', () => {
    it('should validate valid config', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      mockPackage('@tetherto/wdk-wallet-evm-erc-4337')
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')
      mockPackage('@tetherto/pear-wrk-wdk')
      mockPackage('bare-stow-runtime')

      const output = runCli('validate')

      expect(output).toContain('Config file valid')
    })

    it('should check the packages of the folder given with --project-root', () => {
      writeFixtureFile(tempDir, 'config/wdk.config.js', `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
};
`)
      writeStandInWdkProject(path.join(tempDir, 'app'))

      const withFlag = runCli('validate --config config/wdk.config.js --project-root app')
      const withoutFlag = runCli('validate --config config/wdk.config.js')

      expect(withFlag).toContain(`Project root: ${path.join(fs.realpathSync(tempDir), 'app')}`)
      expect(withFlag).toContain('Configuration is valid and ready to build!')
      expect(withoutFlag).toContain('✗ @tetherto/wdk — NOT INSTALLED')
      expect(withoutFlag).toContain('Missing dependencies. Install them before building.')
    })

    it('should fail on missing dependencies', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('validate')

      expect(output).toContain('NOT INSTALLED')
    })

    it('should fail on invalid config', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {},
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('validate')

      expect(output).toContain('Invalid configuration')
    })

    it('should error when no config file exists', () => {
      const output = runCli('validate')
      expect(output).toContain('No wdk.config.js found')
    })
  })

  describe('generate command', () => {
    it('should fail when config is missing', () => {
      const output = runCli('generate')
      expect(output).toContain('No wdk.config.js found')
    })

    describe('with every package installed', () => {
      const ADDRESS_BOOK_SOURCE = 'exports.createWorkletModule = (ctx) => ({ ctx, list: () => [] })\n'

      const writeProject = (config: string): void => {
        fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)
        writeStandInWdkProject(tempDir)
        writeFixtureFile(tempDir, 'node_modules/@tetherto/wdk-p2p-address-book/package.json',
          JSON.stringify({ name: '@tetherto/wdk-p2p-address-book', version: '0.0.0', main: 'index.js' }))
        writeFixtureFile(tempDir, 'node_modules/@tetherto/wdk-p2p-address-book/index.js', ADDRESS_BOOK_SOURCE)
      }

      it('should write the Swift package, with the configured modules in its bundle', () => {
        writeProject(`
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
  modules: {
    addressBook: {
      package: '@tetherto/wdk-p2p-address-book',
      factory: 'createWorkletModule',
      events: ['update'],
    },
  },
  allowedModuleMethods: { addressBook: { methods: ['list'] } },
  output: './out/wallet-worklet',
  options: { targets: ['ios-arm64'] },
};
`)

        // The fixture project has no bare-stow of its own: packing goes through
        // the JS API resolved from the bundler's install, as with a file: dependency.
        const output = runCli('generate --keep-artifacts')
        const entry = fs.readFileSync(path.join(tempDir, '.wdk', 'wdk-worklet.generated.js'), 'utf-8')
        const packageDir = path.join(tempDir, 'out', 'wallet-worklet')

        expect(output).toContain('Package generated successfully')
        expect(output).toContain('(swift, bare-rpc, 4 files)')
        expect(entry).toContain("require('@tetherto/wdk-p2p-address-book'")
        expect(entry).toContain("moduleManagers['addressBook'] = {")
        expect(entry).toContain('moduleManagers: typeof moduleManagers')
        expect(entry).toContain('allowedModuleMethods: {"addressBook":{"methods":["list"]}}')
        expect(listFiles(packageDir)).toEqual([
          '.wdk-worklet-bundler',
          'Package.swift',
          'Sources/WalletWorklet/Client.swift',
          'Sources/WalletWorklet/Harness.swift',
          'Sources/WalletWorklet/index.bundle'
        ])
        const bundle = readStowedBundle(path.join(packageDir, 'Sources/WalletWorklet/index.bundle'))
        expect(readBundleFile(bundle, '/node_modules/@tetherto/wdk-p2p-address-book/index.js')).toBe(ADDRESS_BOOK_SOURCE)
        expect([...bundle.keys()]).toContain('/.wdk/wdk-worklet.generated.js')
      })

      it('should write the Kotlin module into the default output folder and remove the intermediate files', () => {
        writeProject(`
module.exports = {
  transport: 'bare-rpc',
  language: 'kotlin',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
  options: { targets: ['android-arm64'] },
};
`)

        const output = runCli('generate')

        expect(output).toContain('Package generated successfully')
        expect(output).toContain('(kotlin, bare-rpc, 4 files)')
        expect(listFiles(path.join(tempDir, 'wdk-worklet'))).toEqual([
          '.wdk-worklet-bundler',
          'build.gradle',
          'src/main/assets/to/tether/wdk/worklet/index.bundle',
          'src/main/kotlin/to/tether/wdk/worklet/Client.kt',
          'src/main/kotlin/to/tether/wdk/worklet/Harness.kt'
        ])
        expect(fs.existsSync(path.join(tempDir, '.wdk'))).toBe(false)
      })

      it('should fail with what is wrong when the installed pear-wrk-wdk is not the RC line', () => {
        writeProject(`
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
  options: { targets: ['ios-arm64'] },
};
`)
        writeFixtureFile(tempDir, 'node_modules/@tetherto/pear-wrk-wdk/index.js', 'exports.HRPC = class HRPC {}\n')

        const output = runCli('generate')

        expect(output).toContain('Package generation failed')
        expect(output).toContain('does not export createServerProvider, so it cannot serve a bare-stow bundle. Install the RC line of the package: npm install @tetherto/pear-wrk-wdk@github:claudiovb/pear-wrk-wdk#1c72715')
        expect(fs.existsSync(path.join(tempDir, 'wdk-worklet'))).toBe(false)
      })
    })

    describe('with --project-root', () => {
      const CONFIG = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
  options: { targets: ['ios-arm64'] },
};
`

      it('should build from the packages of that folder and write the package next to the config file', () => {
        writeFixtureFile(tempDir, 'config/wdk.config.js', CONFIG)
        writeStandInWdkProject(path.join(tempDir, 'app'))

        const output = runCli('generate --config config/wdk.config.js --project-root app --keep-artifacts')

        expect(output).toContain(`Project root: ${path.join(fs.realpathSync(tempDir), 'app')}`)
        expect(output).toContain('Package generated successfully')
        expect(listFiles(path.join(tempDir, 'config'))).toEqual([
          'wdk-worklet/.wdk-worklet-bundler',
          'wdk-worklet/Package.swift',
          'wdk-worklet/Sources/WdkWorklet/Client.swift',
          'wdk-worklet/Sources/WdkWorklet/Harness.swift',
          'wdk-worklet/Sources/WdkWorklet/index.bundle',
          'wdk.config.js'
        ])
        expect(listFiles(path.join(tempDir, 'app', '.wdk'))).toEqual(['wdk-worklet.generated.js'])
      })

      it('should look for the packages in that folder, not beside the config file', () => {
        writeFixtureFile(tempDir, 'config/wdk.config.js', CONFIG)
        writeStandInWdkProject(path.join(tempDir, 'config'))
        fs.mkdirSync(path.join(tempDir, 'app'))

        const output = runCli('generate --config config/wdk.config.js --project-root app')

        expect(output).toContain('✗ @tetherto/wdk — NOT INSTALLED')
        expect(output).toContain('Cannot proceed without core dependencies.')
        expect(fs.existsSync(path.join(tempDir, 'config', 'wdk-worklet'))).toBe(false)
      })

      it('should write the runtime override into the package.json of that folder with --install', () => {
        writeFixtureFile(tempDir, 'config/wdk.config.js', CONFIG.replace("'@tetherto/wdk-wallet-evm'", "'./local-wdk-module'"))
        writeStandInWdkProject(path.join(tempDir, 'app'))

        runCli('generate --config config/wdk.config.js --project-root app --install')

        expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'app', 'package.json'), 'utf-8'))).toEqual({
          overrides: { 'bare-node-runtime': 'npm:bare-wdk-runtime@^3.0.1' }
        })
        expect(fs.existsSync(path.join(tempDir, 'config', 'package.json'))).toBe(false)
      })

      it('should fail when that folder does not exist', () => {
        writeFixtureFile(tempDir, 'config/wdk.config.js', CONFIG)

        const output = runCli('generate --config config/wdk.config.js --project-root app')

        expect(output).toContain(`Project root not found: ${path.join(fs.realpathSync(tempDir), 'app')}`)
      })
    })

    it('should fail when dependencies are missing', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate')

      expect(output).toContain('Missing core dependencies')
    })

    describe('with --install in an empty project', () => {
      // One real install for the cases below. npm takes the packages from the
      // registry and pear-wrk-wdk from GitHub, so these cases need the network.
      const INSTALL_TIMEOUT_MS = 600000
      let projectDir: string
      let installOutput: string

      const installedVersion = (name: string): string =>
        (JSON.parse(fs.readFileSync(path.join(projectDir, 'node_modules', name, 'package.json'), 'utf-8')) as { version: string }).version

      const filesOutside = (dir: string, addonsDir: string): string[] =>
        listFiles(dir).filter((file) => !file.startsWith(addonsDir))

      beforeAll(() => {
        projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-cli-install-')))
        fs.writeFileSync(path.join(projectDir, 'wdk.config.js'), `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
  options: { targets: ['ios-arm64'] },
};
`)
        installOutput = runCliIn(projectDir, 'generate --install')
      }, INSTALL_TIMEOUT_MS)

      afterAll(() => {
        fs.rmSync(projectDir, { recursive: true, force: true })
      })

      it('should write the override and install the packages of the rc line', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8')) as {
          overrides: Record<string, string>
          dependencies: Record<string, string>
        }

        expect(installOutput).toContain('Installing missing dependencies')
        expect(installOutput).toContain('package.json: override bare-node-runtime → npm:bare-wdk-runtime@^3.0.1')
        expect(pkg.overrides).toEqual({ 'bare-node-runtime': 'npm:bare-wdk-runtime@^3.0.1' })
        expect(Object.keys(pkg.dependencies).sort()).toEqual([
          '@tetherto/pear-wrk-wdk',
          '@tetherto/wdk',
          '@tetherto/wdk-wallet-evm-erc-4337',
          'bare-stow-runtime',
          'bare-wdk-runtime'
        ])
        expect(pkg.dependencies['@tetherto/pear-wrk-wdk']).toBe('github:claudiovb/pear-wrk-wdk#1c72715')
        expect(pkg.dependencies['bare-stow-runtime']).toBe('^0.1.2')
      })

      it('should write the Swift package from what it installed, with the wallets on bare-wdk-runtime', () => {
        const packageDir = path.join(projectDir, 'wdk-worklet')
        const bundle = readStowedBundle(path.join(packageDir, 'Sources/WdkWorklet/index.bundle'))
        const redirectedRuntime = JSON.parse(readBundleFile(bundle, '/node_modules/bare-node-runtime/package.json')) as { name: string }

        expect(installOutput).toContain('Package generated successfully')
        expect(installOutput).not.toContain('bare-node-runtime is installed')
        expect(filesOutside(packageDir, 'Frameworks/')).toEqual([
          '.wdk-worklet-bundler',
          'Package.swift',
          'Sources/WdkWorklet/Client.swift',
          'Sources/WdkWorklet/Harness.swift',
          'Sources/WdkWorklet/index.bundle'
        ])
        expect(fs.existsSync(path.join(packageDir, `Frameworks/sodium-native.${installedVersion('sodium-native')}.xcframework/Info.plist`))).toBe(true)
        expect([...bundle.keys()]).toContain('/.wdk/wdk-worklet.generated.js')
        expect([...bundle.keys()]).toContain('/node_modules/@tetherto/pear-wrk-wdk/worklet.js')
        expect([...bundle.keys()]).toContain('/node_modules/@tetherto/wdk-wallet-evm-erc-4337/package.json')
        expect(redirectedRuntime.name).toBe('bare-wdk-runtime')
      })

      it('should write the Kotlin module from the same install', () => {
        fs.writeFileSync(path.join(projectDir, 'wdk.kotlin.config.js'), `
module.exports = {
  transport: 'bare-rpc',
  language: 'kotlin',
  networks: { ethereum: { package: '@tetherto/wdk-wallet-evm-erc-4337' } },
  output: './kotlin/wdk-worklet',
  options: { targets: ['android-arm64'] },
};
`)

        const output = runCliIn(projectDir, 'generate --config wdk.kotlin.config.js')
        const moduleDir = path.join(projectDir, 'kotlin', 'wdk-worklet')

        expect(output).toContain('Package generated successfully')
        expect(filesOutside(moduleDir, 'src/main/addons/')).toEqual([
          '.wdk-worklet-bundler',
          'build.gradle',
          'src/main/assets/to/tether/wdk/worklet/index.bundle',
          'src/main/kotlin/to/tether/wdk/worklet/Client.kt',
          'src/main/kotlin/to/tether/wdk/worklet/Harness.kt'
        ])
        expect(fs.statSync(path.join(moduleDir, `src/main/addons/arm64-v8a/libsodium-native.${installedVersion('sodium-native')}.so`)).size).toBeGreaterThan(0)
      })
    })

    it('should warn about local paths that cannot be auto-installed', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: './local-wdk-module',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')
      mockPackage('@tetherto/pear-wrk-wdk')
      mockPackage('bare-stow-runtime')

      const output = runCli('generate --install')

      expect(output).toContain('Failed to install')
    })

    it('should show dry run output', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      mockPackage('@tetherto/wdk-wallet-evm-erc-4337')
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')
      mockPackage('@tetherto/pear-wrk-wdk')
      mockPackage('bare-stow-runtime')

      const output = runCli('generate --dry-run')

      expect(output).toContain('Dry run - would generate (transport: bare-rpc, language: swift):')
      expect(output).toContain('.wdk/wdk-worklet.generated.js')
      expect(output).toContain(`Package: ${path.join(fs.realpathSync(tempDir), 'wdk-worklet')}`)
      expect(output).not.toContain('Package generated successfully')
      expect(fs.existsSync(path.join(tempDir, 'wdk-worklet'))).toBe(false)
      expect(fs.existsSync(path.join(tempDir, '.wdk'))).toBe(false)
    })

    it.each(['--link-addons', '--skip-link-addons', '--no-types'])('should reject the removed %s flag', (flag) => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli(`generate ${flag}`)

      expect(output).toContain(`unknown option '${flag}'`)
      expect(output).not.toContain('Checking core dependencies')
    })

    it('should reject the removed --platforms flag', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --platforms ios')

      expect(output).toContain("unknown option '--platforms'")
      expect(output).not.toContain('Checking core dependencies')
    })

    it('should reject --transport jsonrpc and point to the LTS line', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --dry-run --transport jsonrpc')

      expect(output).toContain("/transport: the 'jsonrpc' transport is not available on the 1.0.0-rc line (dist-tag `next`). It stays on the LTS line: use @tetherto/wdk-worklet-bundler@latest.")
      expect(output).not.toContain('Checking core dependencies')
    })

    it('should reject an unknown --transport and name the allowed values', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --dry-run --transport grpc')

      expect(output).toContain('/transport: must be equal to one of the allowed values: bare-rpc, hrpc')
      expect(output).not.toContain('Checking core dependencies')
    })

    it('should take the transport from --transport when the config has none', () => {
      const config = `
module.exports = {
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)
      mockPackage('@tetherto/wdk-wallet-evm-erc-4337')
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')
      mockPackage('@tetherto/pear-wrk-wdk')
      mockPackage('bare-stow-runtime')

      const output = runCli('generate --dry-run --transport hrpc')

      expect(output).toContain('Dry run - would generate (transport: hrpc, language: swift):')
    })
  })

  describe('custom config path', () => {
    it('should use custom config path with -c flag', () => {
      const customConfigPath = path.join(tempDir, 'custom', 'my-config.js')
      fs.mkdirSync(path.dirname(customConfigPath), { recursive: true })

      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(customConfigPath, config)

      mockPackage('@tetherto/wdk-wallet-evm-erc-4337')
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')

      const output = runCli('validate -c custom/my-config.js')

      expect(output).toContain('custom/my-config.js')
    })

    it('should error on non-existent config path', () => {
      const output = runCli('validate -c nonexistent.js')
      expect(output).toContain('Config file not found')
    })
  })
})
