/**
 * Read and write bare-pack bundle artifacts on disk.
 *
 * The `bare-pack` CLI writes the raw bundle bytes verbatim only for a
 * `.bundle` output. For `.bundle.js`/`.bundle.cjs` (the hrpc default,
 * imported by Metro) it wraps them as `module.exports = <json-string>\n`,
 * for `.bundle.mjs` as `export default <json-string>\n`, and for
 * `.bundle.json` as the bare `<json-string>\n`. This package packs through
 * the JS API (pack.ts), so the same extension rule is applied here on write,
 * and every reader of the artifact — native addon discovery, consumers of the
 * public readBundle — gets the raw bytes back keyed on the content prefix
 * rather than the filename.
 */

import fs from 'fs'
import path from 'path'
import Bundle from 'bare-bundle'

/**
 * Text encoding used to stringify the bundle into its wrapped output formats
 * (`module.exports = "..."` etc). The `bare-pack` CLI supports other
 * encodings via `--encoding` (e.g. base64); this package always writes utf8,
 * and a wrapped bundle written in another encoding is not readable here.
 */
export const BUNDLE_TEXT_ENCODING: BufferEncoding = 'utf8'

/** The bare-pack output wrapper present around the raw bundle bytes, if any. */
export type BundleWrapper = 'cjs' | 'mjs' | 'json'

const WRAPPERS: Array<{ kind: BundleWrapper, prefix: string }> = [
  { kind: 'cjs', prefix: 'module.exports = ' },
  { kind: 'mjs', prefix: 'export default ' },
  { kind: 'json', prefix: '' }
]
const PREFIX_WINDOW_BYTES = WRAPPERS.reduce((max, w) => Math.max(max, w.prefix.length), 0) + 1 // +1 for the opening quote of the JSON string literal

/**
 * Strip whichever bare-pack output wrapper is present and JSON.parse the
 * string literal back to the raw bundle bytes (a no-op for a raw `.bundle`).
 */
export function unwrapBundle (raw: Buffer): { wrapper: BundleWrapper | null, bundle: Buffer } {
  const head = raw.subarray(0, PREFIX_WINDOW_BYTES).toString(BUNDLE_TEXT_ENCODING)
  for (const { kind, prefix } of WRAPPERS) {
    if (head.startsWith(prefix + '"')) {
      // Right-hand side is a JSON string literal; JSON.parse tolerates the
      // trailing newline bare-pack appends.
      const bundleStr = JSON.parse(raw.subarray(prefix.length).toString(BUNDLE_TEXT_ENCODING)) as string
      return { wrapper: kind, bundle: Buffer.from(bundleStr, BUNDLE_TEXT_ENCODING) }
    }
  }
  return { wrapper: null, bundle: raw }
}

/** Apply an output wrapper to raw bundle bytes (a no-op for a raw bundle). */
export function rewrapBundle (wrapper: BundleWrapper | null, bundle: Buffer): Buffer {
  if (wrapper === null) return bundle
  const str = JSON.stringify(bundle.toString(BUNDLE_TEXT_ENCODING))
  const prefix = WRAPPERS.find(w => w.kind === wrapper)!.prefix
  return Buffer.from(`${prefix}${str}\n`)
}

/**
 * The wrapper the `bare-pack` CLI would apply for an output path: `.bundle.js`
 * and `.bundle.cjs` get the CommonJS wrapper, `.bundle.mjs` the ESM one,
 * `.bundle.json` a bare JSON string, anything else the raw bytes.
 */
export function wrapperForPath (outputPath: string): BundleWrapper | null {
  if (outputPath.endsWith('.bundle.js') || outputPath.endsWith('.bundle.cjs')) return 'cjs'
  if (outputPath.endsWith('.bundle.mjs')) return 'mjs'
  if (outputPath.endsWith('.bundle.json')) return 'json'
  return null
}

/**
 * Serialize a packed bundle and write it to disk in the wrapper its output
 * path calls for (see wrapperForPath), creating the parent directory.
 *
 * @returns The bytes written, wrapper included.
 */
export function writeBundleFile (outputPath: string, bundle: Bundle): Buffer {
  const data = rewrapBundle(wrapperForPath(outputPath), Buffer.from(bundle.toBuffer()))
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, data)
  return data
}

/**
 * Load a bare-pack artifact from disk as a parsed bare-bundle Bundle,
 * whatever output wrapper bare-pack applied to it.
 *
 * @param bundlePath - Path to a bundle written by this package or the `bare-pack` CLI.
 * @returns The parsed bundle (header, files, addons, resolutions).
 * @throws {Error} If the file does not exist (ENOENT) or does not contain a
 *   bare-pack bundle in any of the supported wrappers.
 */
export function readBundle (bundlePath: string): Bundle {
  const { bundle: raw } = unwrapBundle(fs.readFileSync(bundlePath))
  return Bundle.from(raw as unknown as Parameters<typeof Bundle.from>[0])
}
