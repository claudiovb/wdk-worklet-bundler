/**
 * Pack a worklet module graph into a bare-bundle Bundle with bare-pack's
 * `pack()` API, optionally converting ES modules to CommonJS while the graph
 * is read, and stamp the bundle id. Writing the bundle to disk in its output
 * wrapper is bundle-file.ts's job.
 */

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type Bundle from 'bare-bundle'
import type { PackOptions } from 'bare-pack'
import { isJavaScriptPath, stripModuleType, transformEsmToCjs } from './esm-to-cjs'

/** A module specifier, optionally nested under resolution conditions (bare-module-resolve's shape, via bare-pack's typings). */
export type ConditionalSpecifier = NonNullable<PackOptions['builtins']>[number]

/**
 * bare-pack's own options, forwarded to `pack()` verbatim. `resolve` and
 * `aliases` are set by packBundle. `defer` — specifiers bare-pack records as
 * `deferred:` URLs for the runtime to resolve instead of resolving them at
 * pack time — is consumed by bare-module-resolve but missing from the
 * upstream typings, so it is declared here.
 */
export type BarePackOptions = Omit<PackOptions, 'resolve' | 'aliases'> & { defer?: string[] }

export interface PackBundleOptions {
  /** Absolute path of the entry module. */
  entry: string
  /** Options for bare-pack: at least `base` (file URL of the project root) and `hosts`. */
  packOptions: BarePackOptions
  /**
   * Convert ES modules to CommonJS while packing and store former `.mjs`
   * modules under `.js` keys, for engines whose Bare port can't load ESM
   * (JSC, QuickJS). Defaults to false.
   */
  convertEsmToCjs?: boolean
  /** Minify converted sources. Only applies with `convertEsmToCjs`. Defaults to true. */
  minify?: boolean
}

export interface EsmToCjsStats {
  /** JavaScript modules rewritten to CommonJS. */
  converted: number
  /** package.json files that lost `"type": "module"`. */
  packagesPatched: number
}

export interface PackBundleResult {
  /** The packed bundle, keys relative to `packOptions.base`, header id stamped. */
  bundle: Bundle
  /** Hex content hash of the bundle (bare-bundle-id), also set on the header. */
  id: string
  /** Hosts the bundle was packed for, as passed in `packOptions.hosts`. */
  hosts: string[]
  /** Addon hrefs recorded in the header (`linked:` or `builtin:` URLs). */
  addons: string[]
  /** Number of files in the bundle. */
  files: number
  /** Conversion counters, or null when `convertEsmToCjs` was off. */
  esmToCjs: EsmToCjsStats | null
}

type ReadModule = (url: URL) => Promise<Buffer | null>
type ListPrefix = (url: URL) => AsyncIterable<URL>
type BarePack = (
  entry: URL,
  opts: BarePackOptions & { resolve: unknown, aliases?: PackOptions['aliases'] },
  readModule: ReadModule,
  listPrefix: ListPrefix
) => Promise<Bundle>

// Loaded with require and typed locally: bare-pack and bare-bundle-id declare
// their URL and Buffer parameters with bare-url and bare-buffer, which Node's
// URL and Buffer do not satisfy; bare-pack/fs ships no typings and
// bare-module-traverse's typings omit `resolve`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pack = require('bare-pack') as BarePack
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readModule: readModuleFromDisk, listPrefix } = require('bare-pack/fs') as { readModule: ReadModule, listPrefix: ListPrefix }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolve: traverseResolve } = require('bare-module-traverse') as { resolve: { bare: unknown } }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundleId = require('bare-bundle-id') as (bundle: Bundle) => Buffer

/**
 * Pack the module graph rooted at `options.entry`.
 *
 * @throws {Error} Whatever bare-pack throws: a bare-module-traverse error
 *   with a `code` such as `MODULE_NOT_FOUND` (with `specifier` and
 *   `referrer`), or, when `convertEsmToCjs` is on, esbuild's TransformFailure
 *   for the first module that cannot be converted, naming the file.
 */
export async function packBundle (options: PackBundleOptions): Promise<PackBundleResult> {
  const { entry, packOptions, convertEsmToCjs = false, minify = true } = options

  const stats: EsmToCjsStats = { converted: 0, packagesPatched: 0 }
  const readModule = convertEsmToCjs ? convertingReadModule(stats, minify) : readModuleFromDisk

  const bundle = await pack(pathToFileURL(entry), {
    ...packOptions,
    resolve: traverseResolve.bare,
    // Converted .mjs modules are CommonJS now; storing them under .js keys
    // makes Bare pick the CJS loader by extension, with no runtime patch.
    ...(convertEsmToCjs ? { aliases: { '.mjs': '.js' } } : {})
  }, readModule, listPrefix)

  const id = Buffer.from(bundleId(bundle)).toString('hex')
  bundle.id = id

  return {
    bundle,
    id,
    hosts: packOptions.hosts ?? [],
    addons: [...bundle.addons],
    files: [...bundle.keys()].length,
    esmToCjs: convertEsmToCjs ? stats : null
  }
}

/**
 * readModule that converts JavaScript to CommonJS and strips `"type": "module"`
 * from package manifests as bare-pack reads each file. bare-pack ≥ 2.2
 * memoizes reads, so each file is transformed once however many hosts are
 * packed. A file that cannot be converted fails the pack right there.
 */
function convertingReadModule (stats: EsmToCjsStats, minify: boolean): ReadModule {
  return async (url) => {
    const source = await readModuleFromDisk(url)
    if (source === null) return null

    const filePath = fileURLToPath(url)
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
}
