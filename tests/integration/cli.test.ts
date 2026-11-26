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

  const runCli = (args: string): string => {
    try {
      return execSync(`node ${CLI_PATH} ${args} 2>&1`, {
        encoding: 'utf-8',
        cwd: tempDir
      })
    } catch (error: unknown) {
      const execError = error as { stdout?: string, stderr?: string, message?: string }
      return execError.stdout || execError.stderr || execError.message || ''
    }
  }

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

    it('should create config with proper structure', () => {
      runCli('init -y')

      const configPath = path.join(tempDir, 'wdk.config.js')
      const content = fs.readFileSync(configPath, 'utf-8')

      expect(content).toContain('networks:')
      expect(content).toContain('package:')
      expect(content).toContain('@tetherto/wdk')
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

      const output = runCli('validate')

      expect(output).toContain('Config file valid')
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
        expect(output).toContain('does not export createServerProvider, so it cannot serve a bare-stow bundle. Install the RC line of the package (dist-tag `next`).')
        expect(fs.existsSync(path.join(tempDir, 'wdk-worklet'))).toBe(false)
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

    it('should attempt install with --install flag', () => {
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
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      )

      const output = runCli('generate --install')
      expect(output).toContain('Installing missing dependencies')
    })

    it('should write the runtime override into package.json before installing with npm', () => {
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
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0' })
      )
      mockPackage('@tetherto/wdk')
      mockPackage('bare-wdk-runtime')
      mockPackage('@tetherto/pear-wrk-wdk')

      const output = runCli('generate --install')
      const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8')) as unknown

      expect(output).toContain('package.json: override bare-node-runtime → npm:bare-wdk-runtime@^3.0.1')
      expect(pkg).toEqual({
        name: 'test-project',
        version: '1.0.0',
        overrides: { 'bare-node-runtime': 'npm:bare-wdk-runtime@^3.0.1' }
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

    it('should reject a config that still gives output as an object of paths', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
  output: { bundle: './out/wdk.bundle' },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --dry-run')

      expect(output).toContain("/output: is now one folder, the generated package (a string, default './wdk-worklet').")
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

    it('should reject a config that still carries options.platforms', () => {
      const config = `
module.exports = {
  transport: 'bare-rpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
  options: {
    platforms: ['ios'],
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --dry-run')

      expect(output).toContain('/options/platforms: this option was removed')
      expect(output).not.toContain('Checking core dependencies')
    })

    it('should reject a config with the jsonrpc transport and point to the LTS line', () => {
      const config = `
module.exports = {
  transport: 'jsonrpc',
  language: 'swift',
  networks: {
    ethereum: {
      package: '@tetherto/wdk-wallet-evm-erc-4337',
    },
  },
};
`
      fs.writeFileSync(path.join(tempDir, 'wdk.config.js'), config)

      const output = runCli('generate --dry-run')

      expect(output).toContain("/transport: the 'jsonrpc' transport is not available on the 1.0.0-rc line (dist-tag `next`). It stays on the LTS line: use @tetherto/wdk-worklet-bundler@latest.")
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

    it('should fail when neither the config nor --transport gives a transport', () => {
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

      const output = runCli('generate --dry-run')

      expect(output).toContain("root: must have required property 'transport'")
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
