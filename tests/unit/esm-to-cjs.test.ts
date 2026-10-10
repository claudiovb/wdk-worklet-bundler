import { isJavaScriptPath, minifyJson, stripModuleType, transformEsmToCjs } from '../../src/bundler/esm-to-cjs'

type Factory = (module: { exports: Record<string, unknown> }, exports: Record<string, unknown>, require: (s: string) => unknown) => void

/** Run converted source as a CJS module with the given require table. */
function runCjs (code: string, modules: Record<string, unknown> = {}): Record<string, unknown> {
  const mod = { exports: {} as Record<string, unknown> }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('module', 'exports', 'require', code) as Factory
  fn(mod, mod.exports, (s) => {
    if (!(s in modules)) throw new Error(`unexpected require('${s}')`)
    return modules[s]
  })
  return mod.exports
}

describe('esm-to-cjs transforms', () => {
  describe('isJavaScriptPath', () => {
    it.each(['/a.js', '/a.mjs', '/a.cjs', '/node_modules/x/index.js'])('should accept %s', (p) => {
      expect(isJavaScriptPath(p)).toBe(true)
    })

    it.each(['/a.json', '/package.json', '/a.ts', '/a.jsx', '/a.bare', '/a.node'])('should reject %s', (p) => {
      expect(isJavaScriptPath(p)).toBe(false)
    })
  })

  describe('transformEsmToCjs', () => {
    it('should rewrite static import/export to require/module.exports that executes', () => {
      // Arrange
      const source = "import { base } from 'dep'\nexport const value = base + 1\nexport default function () { return 'd' }\n"

      // Act
      const code = transformEsmToCjs(source)
      const exports = runCjs(code, { dep: { base: 41 } })

      // Assert
      expect(exports.value).toBe(42)
      expect((exports.default as () => string)()).toBe('d')
    })

    it('should lower dynamic import() to a require-based shim', async () => {
      // Arrange
      const source = "export async function lazy () { return (await import('./extra.js')).default }\n"

      // Act — the target is a converted ES module, so it carries esbuild's __esModule marker
      const code = transformEsmToCjs(source)
      const exports = runCjs(code, { './extra.js': { __esModule: true, default: 'extra-loaded' } })

      // Assert
      expect(code).not.toMatch(/[^.\w]import\s*\(/)
      await expect((exports.lazy as () => Promise<string>)()).resolves.toBe('extra-loaded')
    })

    it('should minify by default and keep identifiers when minify is off', () => {
      // Arrange
      const source = 'export const answerToEverything = 40 + 2\n'

      // Act
      const minified = transformEsmToCjs(source)
      const readable = transformEsmToCjs(source, { minify: false })

      // Assert
      expect(minified.length).toBeLessThan(readable.length)
      expect(readable).toContain('answerToEverything')
      expect(runCjs(readable).answerToEverything).toBe(42)
    })

    it('should throw on a syntax error', () => {
      expect(() => transformEsmToCjs('export const = 1')).toThrow()
    })
  })

  describe('stripModuleType', () => {
    it('should remove "type": "module" and keep the other fields', () => {
      // Arrange
      const source = JSON.stringify({ name: 'esm-dep', type: 'module', main: 'index.js' })

      // Act
      const patched = stripModuleType(source)

      // Assert
      expect(patched).not.toBeNull()
      expect(JSON.parse(patched!)).toEqual({ name: 'esm-dep', main: 'index.js' })
    })

    it('should return null when the manifest declares no module type', () => {
      expect(stripModuleType(JSON.stringify({ name: 'cjs-dep' }))).toBeNull()
      expect(stripModuleType(JSON.stringify({ name: 'cjs-dep', type: 'commonjs' }))).toBeNull()
    })

    it('should throw on invalid JSON', () => {
      expect(() => stripModuleType('{ not json')).toThrow()
    })
  })

  describe('minifyJson', () => {
    it('should compact whitespace', () => {
      expect(minifyJson('{\n  "a": [ 1, 2 ]\n}\n')).toBe('{"a":[1,2]}')
    })

    it('should return null for invalid JSON', () => {
      expect(minifyJson('{ not json')).toBeNull()
    })
  })
})
