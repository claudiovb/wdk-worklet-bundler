/**
 * ESM→CJS source transforms applied inflight while bare-pack traverses the
 * module graph (see pack.ts), for engines whose Bare port can't load ES
 * modules: JSC on iOS/macOS exposes no ESM through Apple's public C API, and
 * QuickJS on Bare rejects dynamic `import()`. V8 loads either form.
 *
 * Because the transform runs inside bare-pack's `readModule`, resolution
 * still happens against the original package manifests under `require`
 * conditions, so packages that ship a CJS build resolve to it and only the
 * ESM-only remainder is machine-converted here.
 */

import { transformSync } from 'esbuild'

export interface EsmToCjsTransformOptions {
  /** Minify the converted source. Defaults to true. */
  minify?: boolean
}

/** Whether a module key or path names a JavaScript source file. */
export function isJavaScriptPath (filePath: string): boolean {
  return /\.(js|mjs|cjs)$/.test(filePath)
}

/**
 * Rewrite one module's source to CommonJS: static import/export become
 * require/module.exports and dynamic `import()` is lowered to a
 * require-based shim, so no ESM construct survives on CJS-only engines.
 *
 * @throws {Error} If esbuild cannot parse the source.
 */
export function transformEsmToCjs (source: string, options: EsmToCjsTransformOptions = {}): string {
  const { minify = true } = options
  return transformSync(source, {
    format: 'cjs',
    target: 'es2020',
    // format:'cjs' alone leaves dynamic import() untouched; marking it
    // unsupported lowers import(x) to a require-based shim.
    supported: { 'dynamic-import': false },
    minify,
    legalComments: minify ? 'none' : 'eof'
  }).code
}

/**
 * Drop `"type": "module"` from a package manifest so Bare loads the
 * converted `.js` files of that package through the CJS loader.
 *
 * @returns The rewritten manifest, or null when it declared no module type.
 * @throws {Error} If the manifest is not valid JSON.
 */
export function stripModuleType (source: string): string | null {
  const pkg = JSON.parse(source) as { type?: string }
  if (pkg.type !== 'module') return null
  delete pkg.type
  return JSON.stringify(pkg)
}

/**
 * Re-serialize a JSON document without whitespace.
 *
 * @returns The compact document, or null when the source is not valid JSON
 *   (minification is cosmetic, so the caller keeps the original bytes).
 */
export function minifyJson (source: string): string | null {
  try {
    return JSON.stringify(JSON.parse(source))
  } catch {
    return null
  }
}
