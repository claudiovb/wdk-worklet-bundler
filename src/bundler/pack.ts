/**
 * Pack a worklet module graph into a bare-bundle Bundle through bare-pack's
 * `pack()` JS API.
 *
 * Calling the API instead of shelling out to the `bare-pack` binary means:
 * - bare-pack resolves from this package's own install, so `file:` and
 *   monorepo installs of the bundler work without PATH workarounds;
 * - a missing module surfaces as a typed error instead of a stderr regex;
 * - the ESM→CJS conversion runs inflight through the injected `readModule`
 *   while the graph is traversed (the way Holepunch intends programmatic
 *   transforms to be done), so resolution sees the original manifests and
 *   packages that ship a CJS build resolve to it;
 * - the packed Bundle stays in memory for addon discovery and validation.
 *
 * The glue the `bare-pack` CLI adds around `pack()` — the content-hash id
 * and the extension-based output wrapper — lives here and in bundle-file.ts.
 */

import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import type Bundle from 'bare-bundle'
import { isJavaScriptPath, minifyJson, stripModuleType, transformEsmToCjs } from './esm-to-cjs'

/** A module specifier, optionally nested under resolution conditions (bare-module-resolve's ConditionalSpecifier). */
export type ConditionalSpecifier = string | ConditionalSpecifier[] | { [condition: string]: ConditionalSpecifier }

export interface PackBundleOptions {
  /** Absolute path of the entry module. */
  entry: string
  /** Directory the bundle keys are made relative to, normally the project root. */
  base: string
  /** bare-pack hosts to resolve prebuilds and conditions for, e.g. `ios-arm64`. */
  hosts: string[]
  /** Resolve `require.addon()` to `linked:` URLs the host app ships, instead of packing `file:` prebuilds. Defaults to true. */
  linked?: boolean
  /** Specifiers left unresolved at pack time (`deferred:` URLs), e.g. missing optional peers. */
  defer?: string[]
  /** Global import map overrides applied to every module. */
  imports?: Record<string, ConditionalSpecifier>
  /**
   * Modules and addons the host runtime embeds. Matching specifiers resolve
   * to `builtin:` URLs served by the host instead of being packed or linked,
   * e.g. `[{ addon: 'bare-fs' }]` for an addon compiled into bare-kit.
   */
  builtins?: ConditionalSpecifier[]
  /**
   * Convert ES modules to CommonJS while packing and store former `.mjs`
   * modules under `.js` keys, for engines whose Bare port can't load ESM
   * (JSC, QuickJS). Defaults to false.
   */
  convertEsmToCjs?: boolean
  /** Minify converted sources and JSON files. Only applies with `convertEsmToCjs`. Defaults to true. */
  minify?: boolean
  /** Maximum concurrent module reads; omit for bare-pack's unbounded default. */
  concurrency?: number
}

export interface EsmToCjsStats {
  /** JavaScript modules rewritten to CommonJS. */
  converted: number
  /** package.json files that lost `"type": "module"`. */
  packagesPatched: number
}

export interface PackBundleResult {
  /** The packed bundle, keys relative to `base`, header id stamped. */
  bundle: Bundle
  /** Hex content hash of the bundle (bare-bundle-id), also set on the header. */
  id: string
  /** Hosts the bundle was packed for. */
  hosts: string[]
  /** Addon hrefs recorded in the header (`linked:` or `builtin:` URLs). */
  addons: string[]
  /** Number of files in the bundle. */
  files: number
  /**
   * Whether the packed bundle still carries ES modules — any `.mjs` key or a
   * packed package.json declaring `"type": "module"`. Always false after a
   * conversion; a header-level heuristic, not a parse of every file.
   */
  containsEsm: boolean
  /** Conversion counters, or null when `convertEsmToCjs` was off. */
  esmToCjs: EsmToCjsStats | null
}

/** bare-pack could not resolve a module the graph imports. */
export class MissingModuleError extends Error {
  constructor (public readonly missingModule: string) {
    super(`Missing module: ${missingModule}`)
    this.name = 'MissingModuleError'
  }
}

type ReadModule = (url: URL) => Promise<Buffer | null>
type ListPrefix = (url: URL) => AsyncIterable<URL>
type BarePack = (entry: URL, opts: Record<string, unknown>, readModule: ReadModule, listPrefix: ListPrefix) => Promise<Bundle>

// bare-pack and bare-module-traverse type their callbacks with bare-url/bare-buffer
// shapes; the runtime values are Node's, so they are typed locally here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pack = require('bare-pack') as BarePack
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listPrefix } = require('bare-pack/fs') as { listPrefix: ListPrefix }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolve: traverseResolve } = require('bare-module-traverse') as { resolve: { bare: unknown } }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundleId = require('bare-bundle-id') as (bundle: Bundle) => Buffer

/**
 * Pack the module graph rooted at `options.entry` for the given hosts.
 *
 * @throws {MissingModuleError} If a module in the graph cannot be resolved.
 * @throws {Error} If bare-pack fails for another reason, or if a module
 *   cannot be converted to CommonJS when `convertEsmToCjs` is on (listing the
 *   failing files).
 */
export async function packBundle (options: PackBundleOptions): Promise<PackBundleResult> {
  const {
    entry, base, hosts, linked = true, defer = [], imports = {}, builtins = [],
    convertEsmToCjs = false, minify = true, concurrency
  } = options

  const stats: EsmToCjsStats = { converted: 0, packagesPatched: 0 }
  const failures: string[] = []
  const readModule = convertEsmToCjs ? convertingReadModule(stats, failures, minify) : readModuleFromDisk

  const packOptions: Record<string, unknown> = {
    resolve: traverseResolve.bare,
    hosts,
    linked,
    defer,
    imports,
    builtins,
    base: directoryUrl(base)
  }
  if (concurrency !== undefined) packOptions.concurrency = concurrency
  // Converted .mjs modules are CommonJS now; storing them under .js keys makes
  // Bare pick the CJS loader by extension, with no runtime patch.
  if (convertEsmToCjs) packOptions.aliases = { '.mjs': '.js' }

  let bundle: Bundle
  try {
    bundle = await pack(pathToFileURL(entry), packOptions, readModule, listPrefix)
  } catch (error) {
    throw translatePackError(error)
  }

  if (failures.length > 0) {
    throw new Error(`ESM→CJS conversion failed for ${failures.length} file(s):\n  - ${failures.slice(0, 10).join('\n  - ')}`)
  }

  const id = Buffer.from(bundleId(bundle)).toString('hex')
  bundle.id = id

  return {
    bundle,
    id,
    hosts,
    addons: [...bundle.addons],
    files: [...bundle.keys()].length,
    containsEsm: bundleContainsEsm(bundle),
    esmToCjs: convertEsmToCjs ? stats : null
  }
}

/** Header-level ESM detection; see PackBundleResult.containsEsm. */
export function bundleContainsEsm (bundle: Bundle): boolean {
  for (const key of bundle.keys()) {
    if (key.endsWith('.mjs')) return true
    if (key.endsWith('/package.json')) {
      try {
        if ((JSON.parse(readBundleFile(bundle, key).toString()) as { type?: string }).type === 'module') return true
      } catch {
        // bare-pack parsed this manifest to resolve the graph; unparseable here is not an ESM signal.
      }
    }
  }
  return false
}

function readBundleFile (bundle: Bundle, key: string): Buffer {
  return bundle.read(key) as unknown as Buffer
}

function directoryUrl (dir: string): URL {
  const url = pathToFileURL(dir)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/** bare-pack's own read semantics: the file's bytes, or null when it does not exist. */
async function readModuleFromDisk (url: URL): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(fileURLToPath(url))
  } catch {
    return null
  }
}

/**
 * readModule that converts JavaScript to CommonJS, strips `"type": "module"`
 * and (when minifying) compacts JSON as bare-pack reads each file. bare-pack
 * ≥ 2.2 memoizes reads, so each file is transformed once however many hosts
 * are packed. Conversion failures are collected and the original source is
 * returned, so the whole list is reported after the pack.
 */
function convertingReadModule (stats: EsmToCjsStats, failures: string[], minify: boolean): ReadModule {
  return async (url) => {
    const source = await readModuleFromDisk(url)
    if (source === null) return null

    const filePath = url.pathname
    if (isJavaScriptPath(filePath)) {
      try {
        const code = transformEsmToCjs(source.toString(), { minify })
        stats.converted++
        return Buffer.from(code)
      } catch (e) {
        failures.push(`${filePath}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        return source
      }
    }
    if (filePath.endsWith('/package.json')) {
      // bare-pack parses every manifest it resolves through, so one that no
      // longer parses is a real error — let it surface as a conversion failure.
      try {
        const patched = stripModuleType(source.toString())
        if (patched !== null) {
          stats.packagesPatched++
          return Buffer.from(patched)
        }
        if (minify) {
          const compact = minifyJson(source.toString())
          if (compact !== null) return Buffer.from(compact)
        }
      } catch (e) {
        failures.push(`${filePath}: unreadable package.json: ${e instanceof Error ? e.message : String(e)}`)
      }
      return source
    }
    if (filePath.endsWith('.json') && minify) {
      const compact = minifyJson(source.toString())
      return compact !== null ? Buffer.from(compact) : source
    }
    return source
  }
}

function translatePackError (error: unknown): Error {
  const err = error as { code?: string, specifier?: string, message?: string }
  if (err.code === 'MODULE_NOT_FOUND') {
    const specifier = err.specifier ?? err.message?.match(/Cannot find module '(.+?)'/)?.[1]
    if (specifier !== undefined) return new MissingModuleError(specifier)
  }
  return error instanceof Error ? error : new Error(String(error))
}
