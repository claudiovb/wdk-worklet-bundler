import { validateConfig } from '../../src/config/schema'

// The keys every config needs, so that each case below is about one thing.
const REQUIRED = { transport: 'bare-rpc', language: 'swift' }

describe('Config Schema Validation', () => {
  describe('validateConfig', () => {
    it('should validate a correct config', () => {
      const config = {
        ...REQUIRED,
        networks: {
          ethereum: {
            package: '@tetherto/wdk-wallet-evm-erc-4337'
          }
        },
        protocols: {
          aave: {
            package: '@tetherto/wdk-protocol-aave-v3'
          }
        },
        preloadModules: ['native-addon'],
        output: {
          bundle: './dist/bundle.js',
          types: './dist/types.d.ts'
        },
        options: {
          minify: true,
          sourceMaps: true,
          targets: ['android-arm64']
        }
      }

      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should reject the removed options.platforms key with the migration message', () => {
      // Arrange
      const config = {
        ...REQUIRED,
        networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
        options: { targets: ['ios-arm64'], platforms: ['ios'] }
      }

      // Act & Assert
      expect(() => validateConfig(config)).toThrow(
        'Invalid configuration:\n  - /options/platforms: this option was removed. ' +
        'Addon platforms are derived from options.targets (ios-* → ios, darwin-* → macos, android-* → android); remove the key.'
      )
    })

    it('should reject the jsonrpc transport with the pointer to the LTS line', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        transport: 'jsonrpc'
      }

      expect(() => validateConfig(config)).toThrow(
        "Invalid configuration:\n  - /transport: the 'jsonrpc' transport is not available on the 1.0.0-rc line (dist-tag `next`). " +
        'It stays on the LTS line: use @tetherto/wdk-worklet-bundler@latest.'
      )
    })

    it('should fail if networks is missing', () => {
      const config = {
        ...REQUIRED,
        options: {}
      }

      expect(() => validateConfig(config)).toThrow('must have required property \'networks\'')
    })

    it('should fail if network package is missing', () => {
      const config = {
        ...REQUIRED,
        networks: {
          ethereum: {
          }
        }
      }

      expect(() => validateConfig(config)).toThrow('must have required property \'package\'')
    })

    it('should fail if networks is empty', () => {
      const config = {
        ...REQUIRED,
        networks: {}
      }

      expect(() => validateConfig(config)).toThrow('must NOT have fewer than 1 properties')
    })

    it('should validate protocols if present', () => {
      const config = {
        ...REQUIRED,
        networks: {
          eth: { package: 'pkg' }
        },
        protocols: {
          myproto: {
          }
        }
      }
      expect(() => validateConfig(config)).toThrow('must have required property \'package\'')
    })

    it('should validate a config with a modules section', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        modules: {
          addressBook: {
            package: '@tetherto/wdk-p2p-address-book',
            factory: 'createModule',
            events: ['update']
          }
        }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should validate a minimal module (package only)', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        modules: { addressBook: { package: '@tetherto/wdk-p2p-address-book' } }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should fail if a module package is missing', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        modules: { addressBook: { events: ['update'] } }
      }
      expect(() => validateConfig(config)).toThrow('must have required property \'package\'')
    })

    it('should validate a config with allowedMethods', () => {
      const config = {
        ...REQUIRED,
        networks: { ethereum: { package: 'pkg' } },
        allowedMethods: {
          ethereum: {
            methods: ['getAddress', 'getBalance'],
            protocols: { swap: { uniswap: { methods: ['quoteSwap'] } } }
          }
        }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should fail if a network methods entry is not a string array', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        allowedMethods: { eth: { methods: 'getAddress' } }
      }
      expect(() => validateConfig(config)).toThrow('must be array')
    })

    it('should fail if allowedMethods is a flat surface -> array map (old shape)', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        allowedMethods: { eth: ['getAddress'] }
      }
      expect(() => validateConfig(config)).toThrow('must be object')
    })

    it('should validate a config with allowedModuleMethods', () => {
      const config = {
        ...REQUIRED,
        networks: { ethereum: { package: 'pkg' } },
        allowedModuleMethods: {
          addressBook: { methods: ['list', 'add'] }
        }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should fail if an allowedModuleMethods entry methods is not a string array', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        allowedModuleMethods: { addressBook: { methods: 'list' } }
      }
      expect(() => validateConfig(config)).toThrow('must be array')
    })

    it('should validate options.builtins with string and conditional entries', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { builtins: ['bare-os', { addon: 'bare-fs' }, ['bare-url']] }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should fail if options.builtins is not an array', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { builtins: 'bare-fs' }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    it('should validate options.handleLeakCheck set to true', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: true }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should validate options.handleLeakCheck set to a positive number', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: 5000 }
      }
      expect(() => validateConfig(config)).not.toThrow()
    })

    it('should fail if options.handleLeakCheck is false', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: false }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    it('should fail if options.handleLeakCheck is a string', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: '5000' }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    it('should fail if options.handleLeakCheck is zero', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: 0 }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    it('should fail if options.handleLeakCheck is negative', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: -1000 }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    it('should fail if options.handleLeakCheck is NaN', () => {
      const config = {
        ...REQUIRED,
        networks: { eth: { package: 'pkg' } },
        options: { handleLeakCheck: NaN }
      }
      expect(() => validateConfig(config)).toThrow('Invalid configuration')
    })

    describe('transport and language', () => {
      const networks = { eth: { package: 'pkg' } }

      it('should fail if transport is missing', () => {
        const config = { networks, language: 'swift' }

        expect(() => validateConfig(config)).toThrow("Invalid configuration:\n  - root: must have required property 'transport'")
      })

      it('should fail if language is missing', () => {
        const config = { networks, transport: 'bare-rpc' }

        expect(() => validateConfig(config)).toThrow("Invalid configuration:\n  - root: must have required property 'language'")
      })

      it('should name the allowed values of an unknown transport', () => {
        const config = { networks, transport: 'grpc', language: 'swift' }

        expect(() => validateConfig(config)).toThrow('Invalid configuration:\n  - /transport: must be equal to one of the allowed values: bare-rpc, hrpc')
      })

      it('should name the allowed values of an unknown language', () => {
        const config = { networks, transport: 'bare-rpc', language: 'javascript' }

        expect(() => validateConfig(config)).toThrow('Invalid configuration:\n  - /language: must be equal to one of the allowed values: swift, kotlin')
      })

      it.each([
        ['bare-rpc', 'swift'],
        ['hrpc', 'swift']
      ])('should validate transport %s with language %s', (transport, language) => {
        const config = { networks, transport, language }

        expect(() => validateConfig(config)).not.toThrow()
      })

      it('should validate kotlin with bare-rpc and a Kotlin package', () => {
        const config = { networks, transport: 'bare-rpc', language: 'kotlin', kotlinPackage: 'to.tether.wdk.worklet' }

        expect(() => validateConfig(config)).not.toThrow()
      })

      it('should fail if kotlin has no Kotlin package', () => {
        const config = { networks, transport: 'bare-rpc', language: 'kotlin' }

        expect(() => validateConfig(config)).toThrow(
          "Invalid configuration:\n  - /kotlinPackage: required with language 'kotlin': the Kotlin package of the generated code, for example 'to.tether.wdk.worklet'."
        )
      })

      it('should fail if swift is given a Kotlin package', () => {
        const config = { networks, transport: 'bare-rpc', language: 'swift', kotlinPackage: 'to.tether.wdk.worklet' }

        expect(() => validateConfig(config)).toThrow("Invalid configuration:\n  - /kotlinPackage: only valid with language 'kotlin'.")
      })

      it('should fail if kotlin is combined with hrpc', () => {
        const config = { networks, transport: 'hrpc', language: 'kotlin', kotlinPackage: 'to.tether.wdk.worklet' }

        expect(() => validateConfig(config)).toThrow(
          "Invalid configuration:\n  - /transport: 'hrpc' is not available with language 'kotlin', because there is no HRPC library for Kotlin. Use 'bare-rpc'."
        )
      })

      it('should validate the bare-kit target and name the allowed values of another one', () => {
        const valid = { ...REQUIRED, networks, target: 'bare-kit' }
        const invalid = { ...REQUIRED, networks, target: 'react-native' }

        expect(() => validateConfig(valid)).not.toThrow()
        expect(() => validateConfig(invalid)).toThrow('Invalid configuration:\n  - /target: must be equal to one of the allowed values: bare-kit')
      })
    })

    describe('options.engine', () => {
      const networks = { eth: { package: 'pkg' } }
      const kotlin = { networks, transport: 'bare-rpc', language: 'kotlin', kotlinPackage: 'to.tether.wdk.worklet' }

      it.each([
        ['v8', { ...REQUIRED, networks }],
        ['javascriptcore', { ...REQUIRED, networks }],
        ['v8', kotlin],
        ['quickjs', kotlin]
      ])('should validate engine %s with its language', (engine, base) => {
        const config = { ...base, options: { engine } }

        expect(() => validateConfig(config)).not.toThrow()
      })

      it('should fail if javascriptcore is combined with kotlin', () => {
        const config = { ...kotlin, options: { engine: 'javascriptcore' } }

        expect(() => validateConfig(config)).toThrow("Invalid configuration:\n  - /options/engine: 'javascriptcore' is only available with language 'swift'.")
      })

      it('should fail if quickjs is combined with swift', () => {
        const config = { ...REQUIRED, networks, options: { engine: 'quickjs' } }

        expect(() => validateConfig(config)).toThrow("Invalid configuration:\n  - /options/engine: 'quickjs' is only available with language 'kotlin'.")
      })

      it('should name the allowed values of an unknown engine', () => {
        const config = { ...REQUIRED, networks, options: { engine: 'hermes' } }

        expect(() => validateConfig(config)).toThrow('Invalid configuration:\n  - /options/engine: must be equal to one of the allowed values: v8, javascriptcore, quickjs')
      })

      it('should fail if javascriptcore is combined with convertEsmToCjs false', () => {
        const config = { ...REQUIRED, networks, options: { engine: 'javascriptcore', convertEsmToCjs: false } }

        expect(() => validateConfig(config)).toThrow(
          "Invalid configuration:\n  - /options/convertEsmToCjs: must not be false with engine 'javascriptcore': one ES module in the bundle aborts the process when the worklet starts."
        )
      })

      it('should validate quickjs with convertEsmToCjs false', () => {
        const config = { ...kotlin, options: { engine: 'quickjs', convertEsmToCjs: false } }

        expect(() => validateConfig(config)).not.toThrow()
      })
    })

    describe.each(['maxFrameSize', 'maxBufferedBytes'])('options.%s', (limit) => {
      const networks = { eth: { package: 'pkg' } }

      it('should validate a positive integer with bare-rpc', () => {
        const config = { ...REQUIRED, networks, options: { [limit]: 4 * 1024 * 1024 } }

        expect(() => validateConfig(config)).not.toThrow()
      })

      it('should fail if it is Infinity', () => {
        const config = { ...REQUIRED, networks, options: { [limit]: Infinity } }

        expect(() => validateConfig(config)).toThrow(`Invalid configuration:\n  - /options/${limit}: must be integer`)
      })

      it('should fail if it is zero', () => {
        const config = { ...REQUIRED, networks, options: { [limit]: 0 } }

        expect(() => validateConfig(config)).toThrow(`Invalid configuration:\n  - /options/${limit}: must be >= 1`)
      })

      it('should fail if it is not a whole number', () => {
        const config = { ...REQUIRED, networks, options: { [limit]: 1024.5 } }

        expect(() => validateConfig(config)).toThrow(`Invalid configuration:\n  - /options/${limit}: must be integer`)
      })

      it('should fail if it is combined with hrpc', () => {
        const config = { networks, transport: 'hrpc', language: 'swift', options: { [limit]: 1024 } }

        expect(() => validateConfig(config)).toThrow(`Invalid configuration:\n  - /options/${limit}: only valid with transport 'bare-rpc'.`)
      })
    })

    it('should validate options.debug as a boolean only', () => {
      const valid = { ...REQUIRED, networks: { eth: { package: 'pkg' } }, options: { debug: true } }
      const invalid = { ...REQUIRED, networks: { eth: { package: 'pkg' } }, options: { debug: 'yes' } }

      expect(() => validateConfig(valid)).not.toThrow()
      expect(() => validateConfig(invalid)).toThrow('Invalid configuration:\n  - /options/debug: must be boolean')
    })

    it('should report every invalid combination together', () => {
      const config = {
        networks: { eth: { package: 'pkg' } },
        transport: 'hrpc',
        language: 'kotlin',
        options: { engine: 'javascriptcore', maxFrameSize: 1024 }
      }

      expect(() => validateConfig(config)).toThrow(
        'Invalid configuration:\n' +
        "  - /kotlinPackage: required with language 'kotlin': the Kotlin package of the generated code, for example 'to.tether.wdk.worklet'.\n" +
        "  - /transport: 'hrpc' is not available with language 'kotlin', because there is no HRPC library for Kotlin. Use 'bare-rpc'.\n" +
        "  - /options/engine: 'javascriptcore' is only available with language 'swift'.\n" +
        "  - /options/maxFrameSize: only valid with transport 'bare-rpc'."
      )
    })
  })
})
