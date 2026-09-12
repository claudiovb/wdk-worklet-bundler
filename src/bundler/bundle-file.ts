/**
 * Read and write bare-pack bundle artifacts on disk.
 *
 * bare-pack writes the raw bundle bytes verbatim only for a `.bundle` output.
 * For `.bundle.js`/`.bundle.cjs` (the hrpc default, imported by Metro) it
 * wraps them as `module.exports = <json-string>\n`, for `.bundle.mjs` as
 * `export default <json-string>\n`, and for `.bundle.json` as the bare
 * `<json-string>\n`. Every consumer of the artifact — the ESM→CJS converter,
 * the post-pack validator, native addon discovery — needs the raw bytes, so
 * the wrapper handling lives here, keyed on the content prefix rather than
 * the filename.
 */

import fs from 'fs'
import Bundle from 'bare-bundle'

/**
 * Text encoding used when bare-pack stringifies the bundle into its wrapped
 * output formats (`module.exports = "..."` etc). bare-pack supports other
 * encodings via `--encoding` (e.g. base64), but defaults to utf8 and this
 * package never passes the flag — a non-utf8 wrapped bundle is not supported
 * here and would fail parseHeader/Bundle.from after unwrapping.
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

/** Restore the wrapper stripped by unwrapBundle (a no-op for a raw bundle). */
export function rewrapBundle (wrapper: BundleWrapper | null, bundle: Buffer): Buffer {
  if (wrapper === null) return bundle
  const str = JSON.stringify(bundle.toString(BUNDLE_TEXT_ENCODING))
  const prefix = WRAPPERS.find(w => w.kind === wrapper)!.prefix
  return Buffer.from(`${prefix}${str}\n`)
}

/**
 * Load a bare-pack artifact from disk as a parsed bare-bundle Bundle,
 * whatever output wrapper bare-pack applied to it.
 *
 * @param bundlePath - Path to the bundle written by bare-pack.
 * @returns The parsed bundle (header, files, addons, resolutions).
 * @throws {Error} If the file does not exist (ENOENT) or does not contain a
 *   bare-pack bundle in any of the supported wrappers.
 */
export function readBundle (bundlePath: string): Bundle {
  const { bundle: raw } = unwrapBundle(fs.readFileSync(bundlePath))
  return Bundle.from(raw as unknown as Parameters<typeof Bundle.from>[0])
}
