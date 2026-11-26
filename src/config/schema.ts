/**
 * JSON Schema for wdk.config.js validation
 */

import Ajv from 'ajv'
import type { WdkBundleConfig } from './types'
import { JSONRPC_TRANSPORT_REMOVED } from '../constants'

export const configSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['networks', 'transport', 'language'],
  definitions: {
    protocolAllowedMethods: {
      type: 'object',
      properties: {
        methods: { type: 'array', items: { type: 'string' }, description: 'Methods allowed on this protocol surface' }
      },
      additionalProperties: false
    }
  },
  properties: {
    networks: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['package'],
        properties: {
          package: { type: 'string', description: 'WDK wallet/protocol module name' }
        }
      },
      minProperties: 1,
      description: 'Map of module keys to package name'
    },
    protocols: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['package'],
        properties: {
          package: { type: 'string', description: 'WDK protocol module name' }
        }
      },
      description: 'Map of protocol keys to package name'
    },
    modules: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['package'],
        properties: {
          package: { type: 'string', description: 'Module package exporting a createModule(ctx) factory' },
          factory: { type: 'string', description: "Named factory export to call (default: the package's default export)" },
          events: { type: 'array', items: { type: 'string' }, description: 'Events forwarded host-ward as moduleEvent' }
        }
      },
      description: 'Map of module keys to a generic module package + optional factory/events'
    },
    preloadModules: {
      type: 'array',
      items: { type: 'string' },
      description: 'Modules to preload (native addons)'
    },
    allowedMethods: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          methods: { type: 'array', items: { type: 'string' }, description: 'Methods allowed directly on this network\'s account' },
          protocols: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: { $ref: '#/definitions/protocolAllowedMethods' }
            },
            description: 'protocolType -> protocolName -> allowed methods for that protocol surface'
          }
        },
        additionalProperties: false
      },
      description: 'Map of network name to the methods (and nested protocol surfaces) it allows'
    },
    allowedModuleMethods: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/protocolAllowedMethods' },
      description: 'Map of module name to the methods it allows (for callModule)'
    },
    transport: {
      type: 'string',
      enum: ['bare-rpc', 'hrpc'],
      description: 'Transport the worklet serves'
    },
    language: {
      type: 'string',
      enum: ['swift', 'kotlin'],
      description: 'Language of the generated host package'
    },
    kotlinPackage: {
      type: 'string',
      minLength: 1,
      description: "Kotlin package of the generated code, default 'to.tether.wdk.worklet' (not used with swift)"
    },
    target: {
      type: 'string',
      enum: ['bare-kit'],
      description: 'bare-stow target the bundle is packed for. Defaults to bare-kit.'
    },
    output: {
      type: 'string',
      minLength: 1,
      description: 'Folder of the generated package, relative to the config file. Defaults to ./wdk-worklet.'
    },
    options: {
      type: 'object',
      properties: {
        minify: { type: 'boolean', description: 'Minify output' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hosts the package is built for. Defaults to every host bare-stow supports for the language.'
        },
        convertEsmToCjs: { type: 'boolean', description: 'Convert ESM to CJS while packing (for engines without ESM support in Bare, e.g. JSC, QuickJS). Defaults to false with v8 and to true with the other engines.' },
        engine: {
          type: 'string',
          enum: ['v8', 'javascriptcore', 'quickjs'],
          description: 'JavaScript engine of the Bare Kit build the app ships. javascriptcore (swift only) and quickjs (kotlin only) are experimental. Defaults to v8.'
        },
        maxFrameSize: { type: 'integer', minimum: 1, description: 'Largest frame the worklet accepts over bare-rpc, in bytes. Defaults to 16 MiB.' },
        maxBufferedBytes: { type: 'integer', minimum: 1, description: 'Most bytes a bare-rpc stream of the worklet may buffer. Defaults to 16 MiB.' },
        debug: { type: 'boolean', description: 'Add stack traces to the errors the worklet returns. Not for production builds. Defaults to false.' },
        handleLeakCheck: {
          oneOf: [
            { const: true },
            { type: 'number', exclusiveMinimum: 0 }
          ],
          description: "Enable pear-wrk-wdk's handle-leak diagnostic. Set to `true` for its default tick interval, or a positive number of ms to override it. Omit to disable entirely."
        }
      }
    }
  }
}

const ajv = new Ajv({ allErrors: true, verbose: true })
const validate = ajv.compile(configSchema)

/**
 * Validate configuration against JSON schema
 */
export function validateConfigSchema (config: unknown): asserts config is WdkBundleConfig {
  const valid = validate(config)

  if (!valid && (validate.errors != null)) {
    const errors = validate.errors.map((e) => {
      const path = e.instancePath || 'root'
      const allowed = e.keyword === 'enum' ? `: ${(e.params.allowedValues as string[]).join(', ')}` : ''
      return `  - ${path}: ${e.message}${allowed}`
    })
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`)
  }
}

/**
 * Run all validations
 */
export function validateConfig (config: unknown): asserts config is WdkBundleConfig {
  rejectJsonRpcTransport(config)
  rejectRemovedOutputPaths(config)
  validateConfigSchema(config)
  rejectRemovedOptions(config)
  rejectInvalidCombinations(config)
}

/**
 * The `jsonrpc` transport exists only on the LTS line. The schema's enum
 * would reject it with a generic message, so it fails first, with the pointer
 * to the line that keeps it.
 *
 * @throws {Error} If the config sets `transport: 'jsonrpc'`.
 */
function rejectJsonRpcTransport (config: unknown): void {
  if ((config as { transport?: unknown } | null)?.transport === 'jsonrpc') {
    throw new Error(`Invalid configuration:\n  - /transport: ${JSONRPC_TRANSPORT_REMOVED}`)
  }
}

/**
 * `output` used to be an object of paths (bundle, types, addons,
 * addonsYml). It is now one folder: the schema would reject the old shape
 * with a generic message, so it fails first, with the migration.
 *
 * @throws {Error} If the config still gives `output` as an object.
 */
function rejectRemovedOutputPaths (config: unknown): void {
  const output = (config as { output?: unknown } | null)?.output

  if (typeof output === 'object' && output !== null) {
    throw new Error(
      "Invalid configuration:\n  - /output: is now one folder, the generated package (a string, default './wdk-worklet'). " +
      'The bundle and the native addons are written inside it, so output.bundle, output.types, output.addons and output.addonsYml were removed.'
    )
  }
}

/** Options of earlier lines that no longer exist, with what replaces each. */
const REMOVED_OPTIONS = {
  platforms: 'Addon platforms are derived from options.targets (ios-* → ios, darwin-* → macos, android-* → android); remove the key.',
  sourceMaps: 'Nothing ever produced source maps; remove the key.',
  linkAddons: 'The native addons are always linked into the generated package; remove the key.',
  swiftTarget: 'There is no addons.yml any more: the generated Swift package declares its addons; remove the key.',
  builtins: 'bare-stow links every addon the bundle uses into the generated package; remove the key.'
}

/**
 * A leftover key of a removed option would otherwise be ignored silently, so
 * it fails loading with the migration instead. All leftovers are reported
 * together.
 *
 * @throws {Error} If the config still carries a removed option.
 */
function rejectRemovedOptions (config: WdkBundleConfig): void {
  const errors = Object.entries(REMOVED_OPTIONS)
    .filter(([option]) => config.options !== undefined && option in config.options)
    .map(([option, migration]) => `  - /options/${option}: this option was removed. ${migration}`)

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`)
  }
}

/**
 * The rules that span several keys: what each language, transport and engine
 * can be combined with. All violations are reported together.
 *
 * @throws {Error} If the config combines options that cannot work together.
 */
function rejectInvalidCombinations (config: WdkBundleConfig): void {
  const { language, transport, options = {} } = config
  const errors: string[] = []

  if (language === 'kotlin' && transport === 'hrpc') {
    errors.push("/transport: 'hrpc' is not available with language 'kotlin', because there is no HRPC library for Kotlin. Use 'bare-rpc'.")
  }
  if (options.engine === 'javascriptcore' && language !== 'swift') {
    errors.push("/options/engine: 'javascriptcore' is only available with language 'swift'.")
  }
  if (options.engine === 'quickjs' && language !== 'kotlin') {
    errors.push("/options/engine: 'quickjs' is only available with language 'kotlin'.")
  }
  if (options.engine === 'javascriptcore' && options.convertEsmToCjs === false) {
    errors.push("/options/convertEsmToCjs: must not be false with engine 'javascriptcore': one ES module in the bundle aborts the process when the worklet starts.")
  }
  for (const limit of ['maxFrameSize', 'maxBufferedBytes'] as const) {
    if (transport === 'hrpc' && options[limit] !== undefined) {
      errors.push(`/options/${limit}: only valid with transport 'bare-rpc'.`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  }
}
