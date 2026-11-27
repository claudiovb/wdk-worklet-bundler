import fs from 'fs'
import path from 'path'
import os from 'os'
import vm from 'vm'
import { generateWalletModulesCode } from '../../src/generators/wallet-modules'
import { generateModuleModulesCode } from '../../src/generators/module-modules'
import { generateEntryPoint } from '../../src/generators/entry'
import type { ResolvedConfig } from '../../src/config/types'

describe('Code Generators', () => {
  const createMockConfig = (overrides?: Partial<ResolvedConfig>): ResolvedConfig => ({
    transport: 'bare-rpc',
    language: 'swift',
    networks: {
      ethereum: {
        package: '@tetherto/wdk-wallet-evm-erc-4337'
      },
      polygon: {
        package: '@tetherto/wdk-wallet-evm-erc-4337'
      }
    },
    protocols: {},
    configPath: '/test/wdk.config.js',
    projectRoot: '/test',
    outputDir: '/test/wdk-worklet',
    ...overrides
  })

  describe('generateWalletModulesCode', () => {
    it('should generate core module import', () => {
      const config = createMockConfig()
      const code = generateWalletModulesCode(config)

      expect(code).toContain("const _wdkModule = require('@tetherto/wdk', { with: { imports: 'bare-wdk-runtime/imports' } })")
      expect(code).toContain('WDK = _wdkModule.default || _wdkModule.WDK || _wdkModule')
    })

    it('should generate wallet module imports', () => {
      const config = createMockConfig()
      const code = generateWalletModulesCode(config)

      expect(code).toContain("if (network === 'ethereum') _mod = require('@tetherto/wdk-wallet-evm-erc-4337', { with: { imports: 'bare-wdk-runtime/imports' } })")
      expect(code).toContain('if (_mod) _walletCache[network] = _mod.default || _mod')
    })

    it('should map networks to wallet managers', () => {
      const config = createMockConfig()
      const code = generateWalletModulesCode(config)

      expect(code).toContain("if (network === 'ethereum') _mod = require('@tetherto/wdk-wallet-evm-erc-4337'")
      expect(code).toContain("if (network === 'polygon') _mod = require('@tetherto/wdk-wallet-evm-erc-4337'")
      expect(code).toContain("has: (_, network) => ['ethereum', 'polygon'].includes(network)")
    })

    it('should handle preload modules', () => {
      const config = createMockConfig({
        preloadModules: ['spark-frost-bare-addon']
      })
      const code = generateWalletModulesCode(config)

      expect(code).toContain("require('spark-frost-bare-addon')")
      expect(code).toContain('// Preload modules')
    })

    it('should handle multiple wallet modules', () => {
      const config = createMockConfig({
        networks: {
          ethereum: {
            package: '@tetherto/wdk-wallet-evm-erc-4337'
          },
          spark: {
            package: '@tetherto/wdk-wallet-spark'
          }
        }
      })
      const code = generateWalletModulesCode(config)

      expect(code).toContain("if (network === 'ethereum') _mod = require('@tetherto/wdk-wallet-evm-erc-4337'")
      expect(code).toContain("if (network === 'spark') _mod = require('@tetherto/wdk-wallet-spark'")
      expect(code).toContain("has: (_, network) => ['ethereum', 'spark'].includes(network)")
    })
  })

  describe('generateModuleModulesCode', () => {
    const withModules = (): ResolvedConfig => createMockConfig({
      modules: {
        addressBook: {
          package: '@tetherto/wdk-p2p-address-book',
          events: ['update']
        }
      }
    })

    it('returns a placeholder when no modules configured', () => {
      const code = generateModuleModulesCode(createMockConfig())
      expect(code).toContain('No modules configured')
    })

    it('requires the module package and builds the manager', () => {
      const code = generateModuleModulesCode(withModules())
      expect(code).toContain("const WdkP2pAddressBookRaw = require('@tetherto/wdk-p2p-address-book', { with: { imports: 'bare-wdk-runtime/imports' }})")
      expect(code).toContain("moduleManagers['addressBook'] = {")
    })

    it('defaults the factory to the package default export', () => {
      const code = generateModuleModulesCode(withModules())
      expect(code).toContain('createModule: (ctx) => WdkP2pAddressBook(ctx)')
    })

    it('bakes the declared events', () => {
      const code = generateModuleModulesCode(withModules())
      expect(code).toContain('events: ["update"]')
    })

    it('supports a named factory export', () => {
      const code = generateModuleModulesCode(createMockConfig({
        modules: { foo: { package: 'foo-pkg', factory: 'createModule' } }
      }))
      expect(code).toContain('createModule: (ctx) => FooPkg.createModule(ctx)')
    })

    it('stays free of any storage/corestore specifics', () => {
      const code = generateModuleModulesCode(withModules())
      expect(code).not.toContain("require('corestore'")
      expect(code).not.toContain('createStore')
      expect(code).not.toContain('state:')
    })

    // Squash the "emitted string is valid, executable JS producing the right
    // runtime shape" caveat: actually evaluate the generated code with a stubbed
    // require and assert the resulting WdkModuleManager behaves correctly.
    it('emits valid JS that executes to a correct WdkModuleManager', () => {
      const code = generateModuleModulesCode(withModules())

      const factory = jest.fn((ctx: unknown) => ({ instance: true, ctx }))
      const requireStub = (id: string): unknown => {
        if (id === '@tetherto/wdk-p2p-address-book') return factory
        throw new Error('unexpected require: ' + id)
      }

      interface GeneratedManager {
        events: string[]
        createModule: (ctx: unknown) => unknown
      }
      type Build = (require: (id: string) => unknown) => Record<string, GeneratedManager>

      // Intentionally execute the generated code to prove it is valid, runnable JS.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const build = new Function('require', `${code}\nreturn moduleManagers;`) as unknown as Build
      const moduleManagers = build(requireStub)
      const mgr = moduleManagers.addressBook

      expect(mgr.events).toEqual(['update'])
      expect(typeof mgr.createModule).toBe('function')

      const ctx = { seed: 'SEED', config: { namespace: 'tether-wallet' }, capabilities: {}, emit: (): void => {} }
      mgr.createModule(ctx)
      expect(factory).toHaveBeenCalledWith(ctx)
    })
  })

  describe('generateEntryPoint', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-entry-test-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('should create entry file in output directory', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)

      expect(fs.existsSync(entryPath)).toBe(true)
      expect(entryPath).toBe(path.join(tempDir, 'wdk-worklet.generated.js'))
    })

    it('should include generated header comment', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('Auto-generated by @tetherto/wdk-worklet-bundler')
      expect(content).toContain('DO NOT EDIT MANUALLY')
    })

    it('should include core dependencies', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain("require('bare-wdk-runtime/global')")
      expect(content).toContain("require('@tetherto/pear-wrk-wdk/worklet'")
    })

    it('should end by exporting the start function made by createStart, and wire no transport itself', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content.endsWith("logger.info('Worklet started');\n\nmodule.exports = createStart(context);")).toBe(true)
      expect(content).not.toContain('HRPC')
      expect(content).not.toContain('registerRpcHandlers')
      expect(content).not.toContain('BareKit')
    })

    it('should generate the same entry for both transports, apart from the timestamp line', async () => {
      const withoutTimestamp = (content: string): string => content.replace(/^\/\/ Generated at: .*\n/m, '')
      const bareRpcDir = path.join(tempDir, 'bare-rpc')
      const hrpcDir = path.join(tempDir, 'hrpc')

      const bareRpc = fs.readFileSync(await generateEntryPoint(createMockConfig({ transport: 'bare-rpc' }), bareRpcDir), 'utf-8')
      const hrpc = fs.readFileSync(await generateEntryPoint(createMockConfig({ transport: 'hrpc' }), hrpcDir), 'utf-8')

      expect(withoutTimestamp(hrpc)).toBe(withoutTimestamp(bareRpc))
      expect(bareRpc).not.toBe(withoutTimestamp(bareRpc))
    })

    describe('when the generated entry runs', () => {
      const start = (): void => {}

      /**
       * Run the generated entry with a stubbed require, as Bare would load it,
       * and return what it gave createStart and what it exported.
       */
      async function run (config: ResolvedConfig, loadWdk: () => unknown): Promise<{ context: Record<string, unknown>, exported: unknown }> {
        const code = fs.readFileSync(await generateEntryPoint(config, tempDir), 'utf-8')
        const createStart = jest.fn<() => void, [Record<string, unknown>]>(() => start)
        const module = { exports: {} as unknown }
        const requireStub = (id: string): unknown => {
          if (id === 'bare-wdk-runtime/global') return {}
          if (id === '@tetherto/wdk') return loadWdk()
          if (id === '@tetherto/pear-wrk-wdk/worklet') return { createStart, utils: { logger: { info: (): void => {}, error: (): void => {} } } }
          throw new Error('Unexpected require: ' + id)
        }
        requireStub.cache = {}

        vm.runInNewContext(code, { require: requireStub, module, console: { log: (): void => {}, error: (): void => {} } })

        return { context: createStart.mock.calls[0][0], exported: module.exports }
      }

      it('should export the start function createStart returned', async () => {
        const { exported } = await run(createMockConfig(), () => class WDK {})

        expect(exported).toBe(start)
      })

      it('should pass a null wdkLoadError and the WDK class when the WDK loads', async () => {
        class WDK {}

        const { context } = await run(createMockConfig(), () => WDK)

        expect(context.wdkLoadError).toBeNull()
        expect(context.WDK).toBe(WDK)
      })

      it('should pass the error the WDK threw while loading as wdkLoadError', async () => {
        const loadError = new Error('Unsupported operation')

        const { context } = await run(createMockConfig(), () => { throw loadError })

        expect(context.wdkLoadError).toBe(loadError)
        expect(context.WDK).toBeNull()
      })

      it('should pass debug: false in the context by default', async () => {
        const { context } = await run(createMockConfig(), () => class WDK {})

        expect(context.debug).toBe(false)
      })

      it('should pass debug: true in the context when options.debug is set', async () => {
        const { context } = await run(createMockConfig({ options: { debug: true } }), () => class WDK {})

        expect(context.debug).toBe(true)
      })

    })

    it('should include wallet modules code', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain("require('@tetherto/wdk'")
      expect(content).toContain("require('@tetherto/wdk-wallet-evm-erc-4337'")
    })

    it('should wire modules into context when configured', async () => {
      const config = createMockConfig({
        modules: {
          addressBook: {
            package: '@tetherto/wdk-p2p-address-book',
            events: ['update']
          }
        }
      })
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain("moduleManagers['addressBook'] = {")
      expect(content).toContain("require('@tetherto/wdk-p2p-address-book'")
      expect(content).toContain("moduleManagers: typeof moduleManagers !== 'undefined' ? moduleManagers : {}")
    })

    it('should default modules to an empty map when none configured', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('// No modules configured')
      expect(content).toContain("moduleManagers: typeof moduleManagers !== 'undefined' ? moduleManagers : {}")
    })

    it('should wire allowedMethods into context when configured', async () => {
      const config = createMockConfig({
        allowedMethods: {
          ethereum: {
            methods: ['getAddress', 'getBalance'],
            protocols: { swap: { uniswap: { methods: ['quoteSwap'] } } }
          }
        }
      })
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('allowedMethods: {"ethereum":{"methods":["getAddress","getBalance"],"protocols":{"swap":{"uniswap":{"methods":["quoteSwap"]}}}}}')
    })

    it('should default allowedMethods to an empty map when none configured', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('allowedMethods: {}')
    })

    it('should wire allowedModuleMethods into context when configured', async () => {
      const config = createMockConfig({
        allowedModuleMethods: {
          addressBook: { methods: ['list', 'add'] }
        }
      })
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('allowedModuleMethods: {"addressBook":{"methods":["list","add"]}}')
    })

    it('should default allowedModuleMethods to an empty map when none configured', async () => {
      const config = createMockConfig()
      const entryPath = await generateEntryPoint(config, tempDir)
      const content = fs.readFileSync(entryPath, 'utf-8')

      expect(content).toContain('allowedModuleMethods: {}')
    })

    it('should create output directory if it does not exist', async () => {
      const config = createMockConfig()
      const nestedDir = path.join(tempDir, 'nested', 'output')

      const entryPath = await generateEntryPoint(config, nestedDir)

      expect(fs.existsSync(nestedDir)).toBe(true)
      expect(fs.existsSync(entryPath)).toBe(true)
    })

    describe('options.handleLeakCheck', () => {
      it('should include the require and registerHandleLeakCheck() call when enabled and resolvable', async () => {
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-entry-handle-leak-proj-'))
        const pkgDir = path.join(projectRoot, 'node_modules/@tetherto/pear-wrk-wdk')
        fs.mkdirSync(path.join(pkgDir, 'diagnostics'), { recursive: true })
        fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
          name: '@tetherto/pear-wrk-wdk',
          version: '9.9.9',
          exports: { './diagnostics/handle-leak-check': './diagnostics/handle-leak-check.js' }
        }))
        fs.writeFileSync(
          path.join(pkgDir, 'diagnostics/handle-leak-check.js'),
          'module.exports = { registerHandleLeakCheck () {} }'
        )

        try {
          const config = createMockConfig({ projectRoot, options: { handleLeakCheck: 5000 } })
          const entryPath = await generateEntryPoint(config, tempDir)
          const content = fs.readFileSync(entryPath, 'utf-8')

          expect(content).toContain("const { registerHandleLeakCheck } = require('@tetherto/pear-wrk-wdk/diagnostics/handle-leak-check');")
          expect(content).toContain('registerHandleLeakCheck({ tickIntervalMs: 5000 });')
        } finally {
          fs.rmSync(projectRoot, { recursive: true, force: true })
        }
      })

    })
  })
})
