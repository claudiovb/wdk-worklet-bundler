/**
 * Pack a worklet with bare-stow: one call packs the module graph, links the
 * native addons and writes the host package (Swift package, Kotlin module or
 * JavaScript harness) that starts the bundle. The server inside the bundle is
 * the provider pear-wrk-wdk exports for the transport.
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import { isJavaScriptPath, stripModuleType, transformEsmToCjs } from './esm-to-cjs'
import { PEAR_WRK_WDK_INSTALL_SPEC } from '../constants'

const PEAR_WRK_WDK = '@tetherto/pear-wrk-wdk'

export interface EsmToCjsStats {
  /** JavaScript modules rewritten to CommonJS. */
  converted: number
  /** package.json files that lost `"type": "module"`. */
  packagesPatched: number
}

/** The language of the host package, with the options bare-stow takes for it. */
export type StowLanguage =
  | { name: 'swift' }
  | {
    name: 'kotlin'
    /** Package of the generated code, which is also the namespace of the module. */
    package: string
    /** Defaults to 'android'. */
    platform?: 'android' | 'jvm'
  }
  | {
    name: 'javascript'
    /** Module system of the generated harness. Defaults to 'esm'. */
    module?: 'esm' | 'cjs'
  }

/** The limits of a `bare-rpc` session, as pear-wrk-wdk's provider takes them. */
export interface BareRpcLimits {
  /** Largest frame the worklet accepts, in bytes. */
  maxFrameSize?: number
  /** Most bytes a stream of the session may buffer. */
  maxBufferedBytes?: number
}

/** What bare-stow gives a client generator: the role, and the options of the language. */
export interface ClientContext {
  role: 'client'
  options: Record<string, unknown>
}

/** What a client extension adds for one language. */
export interface ClientAddition {
  /** Code appended to the client file bare-stow generates (`Client.swift`, `Client.kt`). */
  source: string
  /** Dependencies added to the manifest of the host package, as the language of bare-stow takes them. */
  dependencies?: Record<string, unknown>
}

/**
 * Adds code and dependencies to the `bare-rpc` client of the host package, per
 * language. Shaped like a bare-stow provider, but what `generate` returns is
 * added to bare-stow's own client, not used in its place.
 */
export interface ClientExtension {
  name: string
  languages: Partial<Record<StowLanguage['name'], { generate: (context: ClientContext) => ClientAddition }>>
}

export interface StowBundleOptions {
  /** Absolute path of the entry module. */
  entry: string
  /** Absolute path of the folder the host package is written to. */
  out: string
  /** Absolute path of the folder @tetherto/pear-wrk-wdk is installed in. */
  projectRoot: string
  /**
   * The bare-stow target: 'bare-kit' for a Bare Kit worklet started from
   * Swift or Kotlin, 'bare-sidecar' for a Bare process started from Node.
   */
  target: 'bare-kit' | 'bare-sidecar'
  language: StowLanguage
  /**
   * The transport the worklet serves. With 'bare-rpc' the host package also
   * gets bare-stow's `bare-rpc` client; with 'hrpc' it has no client.
   */
  transport: 'bare-rpc' | 'hrpc'
  /** Only with the 'bare-rpc' transport. */
  limits?: BareRpcLimits
  /** Additions to the generated client. Only with the 'bare-rpc' transport. */
  clientExtension?: ClientExtension
  /** JavaScript engine of the 'bare-kit' target. Defaults to bare-stow's own, 'v8'. */
  engine?: 'v8' | 'javascriptcore' | 'quickjs'
  /** Hosts to pack and link for. Defaults to every host of the target for the language. */
  hosts?: string[]
  /** Specifiers left for the runtime to resolve instead of failing the pack. */
  defer?: string[]
  /**
   * Convert ES modules to CommonJS while packing and store former `.mjs`
   * modules under `.js` keys, for engines whose Bare port can't load ESM
   * (JSC, QuickJS). Defaults to false.
   */
  convertEsmToCjs?: boolean
  /** Minify converted sources. Only applies with `convertEsmToCjs`. Defaults to true. */
  minify?: boolean
}

export interface StowBundleResult {
  /** Absolute path of the bundle inside the host package. */
  bundlePath: string
  /** Absolute path of every file written, in the order bare-stow wrote them. */
  files: string[]
  /** Conversion counters, or null when `convertEsmToCjs` was off. */
  esmToCjs: EsmToCjsStats | null
}

type ReadModule = (url: URL) => Promise<Buffer | null>

/** A bare-stow RPC provider, as pear-wrk-wdk's `createServerProvider` returns it. */
interface ServerProvider {
  name: string
  languages: Record<string, unknown>
}

/** A bare-stow client provider, as its built-in `bare-rpc` one. */
interface ClientProvider {
  name: string
  languages: Record<string, { generate: (context: ClientContext) => Required<ClientAddition> }>
}

/** The options of bare-stow this module sets. */
interface StowOptions {
  language: StowLanguage['name']
  languageOptions: Record<string, unknown>
  targetOptions?: { engine: NonNullable<StowBundleOptions['engine']> }
  server: ServerProvider
  client?: 'bare-rpc' | ClientProvider
  hosts?: string[]
  defer?: string[]
  readModule?: ReadModule
  aliases?: Record<string, string>
}

type Stow = (
  entry: URL,
  target: StowBundleOptions['target'],
  out: URL,
  opts: StowOptions
) => AsyncGenerator<{ url: URL, base?: URL }>

// Loaded with require and typed locally: bare-stow declares its URL parameters
// with bare-url, which Node's URL does not satisfy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stow = require('bare-stow') as Stow

/**
 * Pack the module graph rooted at `options.entry` and write the host package
 * into `options.out`.
 *
 * @throws {Error} If the @tetherto/pear-wrk-wdk installed in the project is
 *   missing or does not export `createServerProvider`.
 * @throws {Error} If a client extension is given with the 'hrpc' transport, or
 *   has no generator for the language.
 * @throws {Error} Whatever bare-stow throws: an invalid language option, host
 *   or output folder name; a bare-module-traverse error with a `code` such as
 *   `MODULE_NOT_FOUND` (with `specifier` and `referrer`); or, when
 *   `convertEsmToCjs` is on, esbuild's TransformFailure for the first module
 *   that cannot be converted, naming the file.
 */
export async function stowBundle (options: StowBundleOptions): Promise<StowBundleResult> {
  const { entry, out, projectRoot, target, transport, convertEsmToCjs = false, minify = true } = options
  const { name: language, ...languageOptions } = options.language

  assertClientExtension(options.clientExtension, transport, language)

  const stats: EsmToCjsStats | null = convertEsmToCjs ? { converted: 0, packagesPatched: 0 } : null

  const artifacts = stow(pathToFileURL(entry), target, pathToFileURL(out), {
    language,
    languageOptions: defined(languageOptions),
    server: loadServerProvider(projectRoot, transport, options.limits),
    ...(transport === 'bare-rpc' ? { client: bareRpcClient(language, options.clientExtension) } : {}),
    ...(options.engine !== undefined ? { targetOptions: { engine: options.engine } } : {}),
    ...defined({ hosts: options.hosts, defer: options.defer }),
    // Converted .mjs modules are CommonJS now; storing them under .js keys
    // makes Bare pick the CJS loader by extension, with no runtime patch.
    ...(stats !== null ? { readModule: convertingReadModule(stats, minify), aliases: { '.mjs': '.js' } } : {})
  })

  const files: string[] = []
  let bundlePath = ''

  // The files are written as the generator is read. Only the bundle carries a base.
  for await (const artifact of artifacts) {
    const file = fileURLToPath(artifact.url)
    files.push(file)
    if (artifact.base !== undefined) bundlePath = file
  }

  return { bundlePath, files, esmToCjs: stats }
}

/**
 * Check that a client extension can be used with the transport and the language.
 *
 * @throws {Error} With the 'hrpc' transport, for which no client is generated.
 * @throws {Error} If the extension has no generator for the language.
 */
export function assertClientExtension (
  extension: ClientExtension | undefined,
  transport: StowBundleOptions['transport'],
  language: StowLanguage['name']
): void {
  if (extension === undefined) return

  if (transport !== 'bare-rpc') {
    throw new Error(`The client extension '${extension.name}' needs transport 'bare-rpc': no client is generated with '${transport}'.`)
  }
  if (extension.languages[language] === undefined) {
    throw new Error(`The client extension '${extension.name}' has no generator for language '${language}'.`)
  }
}

/**
 * Load a client extension from a CommonJS module.
 *
 * @param modulePath - Absolute path of the module.
 * @throws {Error} If the module cannot be loaded, or does not export
 *   `{ name, languages }`.
 */
export function loadClientExtension (modulePath: string): ClientExtension {
  const extension = createRequire(modulePath)(modulePath) as Partial<ClientExtension> | null

  if (typeof extension?.name !== 'string' || typeof extension.languages !== 'object' || extension.languages === null) {
    throw new Error(`The client extension ${modulePath} must export { name, languages }.`)
  }

  return extension as ClientExtension
}

/**
 * The client given to bare-stow: its built-in `bare-rpc` one by name, or, with
 * an extension, that one with the additions of the extension for the language.
 */
function bareRpcClient (language: StowLanguage['name'], extension?: ClientExtension): 'bare-rpc' | ClientProvider {
  const addition = extension?.languages[language]

  if (addition === undefined) return 'bare-rpc'

  // bare-stow does not export its bare-rpc client generator, so it is loaded by
  // file from the installed package, which is pinned to an exact version.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const builtIn = require(path.join(path.dirname(require.resolve('bare-stow/package')), 'lib/rpc/bare-rpc.js')) as ClientProvider

  return {
    name: builtIn.name,
    languages: {
      ...builtIn.languages,
      [language]: {
        generate (context) {
          const client = builtIn.languages[language].generate(context)
          const added = addition.generate(context)

          return {
            source: client.source + added.source,
            dependencies: { ...client.dependencies, ...added.dependencies }
          }
        }
      }
    }
  }
}

/**
 * Load the server provider of the transport from the pear-wrk-wdk installed
 * in the project. Only the RC line exports it, so its absence means the
 * installed version cannot serve a bare-stow bundle.
 *
 * @throws {Error} If the package is not installed, or does not export
 *   `createServerProvider`.
 */
function loadServerProvider (
  projectRoot: string,
  transport: StowBundleOptions['transport'],
  limits: BareRpcLimits = {}
): ServerProvider {
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'))
  const { createServerProvider } = requireFromProject(PEAR_WRK_WDK) as {
    createServerProvider?: (transport: string, options?: BareRpcLimits) => ServerProvider
  }

  if (typeof createServerProvider !== 'function') {
    throw new Error(
      `The ${PEAR_WRK_WDK} installed in ${projectRoot} does not export createServerProvider, ` +
      `so it cannot serve a bare-stow bundle. Install the RC line of the package: npm install ${PEAR_WRK_WDK_INSTALL_SPEC}`
    )
  }

  return transport === 'bare-rpc' ? createServerProvider(transport, defined(limits)) : createServerProvider(transport)
}

/**
 * readModule that converts JavaScript to CommonJS and strips `"type": "module"`
 * from package manifests as bare-stow reads each file. bare-stow reads the
 * graph more than once (to pack it, then to link its addons), so each result
 * is kept by URL and every file is transformed and counted once. A file that
 * cannot be converted fails the pack right there.
 */
function convertingReadModule (stats: EsmToCjsStats, minify: boolean): ReadModule {
  const reads = new Map<string, Promise<Buffer | null>>()

  const read = async (url: URL): Promise<Buffer | null> => {
    const filePath = fileURLToPath(url)

    let source: Buffer
    try {
      source = await fs.promises.readFile(filePath)
    } catch {
      // bare-stow probes candidate paths while resolving: no file, no module.
      return null
    }

    if (isJavaScriptPath(filePath)) {
      const code = transformEsmToCjs(source.toString(), { minify, sourcefile: filePath })
      stats.converted++
      return Buffer.from(code)
    }
    if (filePath.endsWith(`${path.sep}package.json`)) {
      let patched: string | null
      try {
        patched = stripModuleType(source.toString())
      } catch (e) {
        throw new Error(`${filePath}: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (patched !== null) {
        stats.packagesPatched++
        return Buffer.from(patched)
      }
    }
    return source
  }

  return async (url) => {
    let reading = reads.get(url.href)
    if (reading === undefined) {
      reading = read(url)
      reads.set(url.href, reading)
    }
    return await reading
  }
}

/** Drop the keys whose value is undefined, so the defaults of the callee apply. */
function defined<T extends object> (values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>
}
