/**
 * Integration test: pack a fixture project through the REAL bare-pack JS API
 * (packBundle) and verify the result structurally, through the wrappers
 * writeBundleFile applies, and by executing a converted bundle under a
 * CJS-only module loader (what a JSC/QuickJS worklet effectively is).
 *
 * Nothing here reimplements bare-pack's output — header layout, resolutions
 * and addon hrefs all come from bare-pack itself, so a bare-pack format change
 * breaks this test instead of silently diverging from our assumptions.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import type Bundle from 'bare-bundle'
import { readBundle, writeBundleFile } from '../../src/bundler/bundle-file'
import { MissingModuleError, packBundle } from '../../src/bundler/pack'
import { discoverLinkedAddons } from '../../src/bundler/linked-addons'

type ModuleFactory = (
  module: { exports: unknown },
  exports: unknown,
  require: (spec: string) => unknown,
  filename: string,
  dirname: string
) => void

function readFile (bundle: Bundle, key: string): string {
  return (bundle.read(key) as unknown as Buffer).toString()
}

/**
 * Minimal CJS-only loader over a bundle: every file loads as CJS regardless
 * of extension, specifiers resolve through the header's resolutions.
 */
function makeLoader (bundle: Bundle): (file: string) => unknown {
  const resolutions = bundle.resolutions as Record<string, Record<string, string>>
  const cache: Record<string, { exports: unknown }> = {}
  const resolve = (spec: string, from: string): string => {
    const viaHeader = resolutions[from]?.[spec]
    if (viaHeader !== undefined) return viaHeader
    if (spec.startsWith('.')) {
      const base = path.posix.join(path.posix.dirname(from), spec)
      for (const cand of [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`]) {
        if (bundle.exists(cand)) return cand
      }
    }
    if (bundle.exists(spec)) return spec
    throw new Error(`Cannot resolve '${spec}' from '${from}'`)
  }
  const requireFile = (file: string): unknown => {
    if (cache[file]) return cache[file].exports
    if (file.endsWith('.json')) {
      cache[file] = { exports: JSON.parse(readFile(bundle, file)) as unknown }
      return cache[file].exports
    }
    const mod: { exports: unknown } = { exports: {} }
    cache[file] = mod
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', readFile(bundle, file)) as ModuleFactory
    fn(mod, mod.exports, (s: string) => requireFile(resolve(s, file)), file, path.posix.dirname(file))
    return mod.exports
  }
  return requireFile
}

describe('packBundle against the real bare-pack', () => {
  let tempDir: string
  let projDir: string
  let entry: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-pack-bundle-'))
    projDir = path.join(tempDir, 'proj')
    entry = path.join(projDir, 'entry.js')

    // Fixture: CJS entry -> ESM package ("type": "module") -> dynamic import
    // of an .mjs file, plus a native addon package required directly.
    const dep = path.join(projDir, 'node_modules/esm-dep')
    fs.mkdirSync(dep, { recursive: true })
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
      name: 'esm-dep', version: '1.0.0', type: 'module', main: 'index.js'
    }))
    fs.writeFileSync(path.join(dep, 'index.js'),
      "export async function lazy () { return (await import('./extra.mjs')).default }\n" +
      'export const value = 42\n')
    fs.writeFileSync(path.join(dep, 'extra.mjs'), "export default 'extra-loaded'\n")

    const native = path.join(projDir, 'node_modules/native-dep')
    fs.mkdirSync(native, { recursive: true })
    fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({
      name: 'native-dep', version: '1.2.3', addon: true, main: 'index.js'
    }))
    fs.writeFileSync(path.join(native, 'index.js'), 'module.exports = require.addon()\n')

    fs.writeFileSync(entry,
      "const dep = require('esm-dep')\n" +
      "exports.dep = dep\n" +
      "exports.loadNative = () => require('native-dep')\n")
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const hosts = ['ios-arm64', 'android-arm64']

  describe('with convertEsmToCjs on', () => {
    it('should pack a CJS-only bundle under .js keys that executes', async () => {
      // Act
      const result = await packBundle({ entry, base: projDir, hosts, convertEsmToCjs: true })

      // Assert — keys, header, counters
      const keys = [...result.bundle.keys()]
      expect(keys).toContain('/node_modules/esm-dep/extra.js')
      expect(keys.some(k => k.endsWith('.mjs'))).toBe(false)
      expect(JSON.parse(readFile(result.bundle, '/node_modules/esm-dep/package.json'))).not.toHaveProperty('type')
      expect(result.bundle.main).toBe('/entry.js')
      expect(result.containsEsm).toBe(false)
      expect(result.esmToCjs).toEqual({ converted: 4, packagesPatched: 1 })
      expect(result.files).toBe(keys.length)
      expect(result.hosts).toEqual(hosts)

      // Assert — no ESM syntax survives
      for (const key of keys.filter(k => /\.(js|cjs)$/.test(k))) {
        const code = readFile(result.bundle, key)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        expect(() => new Function(code)).not.toThrow()
        expect(code).not.toMatch(/[^.\w]import\s*\(/)
      }

      // Assert — the converted graph runs under a CJS-only loader, across the former .mjs
      const requireFile = makeLoader(result.bundle)
      const exported = requireFile(result.bundle.main!) as { dep: { value: number, lazy: () => Promise<string> } }
      expect(exported.dep.value).toBe(42)
      await expect(exported.dep.lazy()).resolves.toBe('extra-loaded')
    })

    it('should stamp a content-hash id that only changes with the content', async () => {
      // Act
      const a = await packBundle({ entry, base: projDir, hosts, convertEsmToCjs: true })
      const b = await packBundle({ entry, base: projDir, hosts, convertEsmToCjs: true })
      const readable = await packBundle({ entry, base: projDir, hosts, convertEsmToCjs: true, minify: false })

      // Assert
      expect(a.id).toMatch(/^[0-9a-f]{64}$/)
      expect(a.bundle.id).toBe(a.id)
      expect(b.id).toBe(a.id)
      expect(readable.id).not.toBe(a.id)
    })
  })

  describe('with convertEsmToCjs off', () => {
    it('should keep ES modules verbatim and report containsEsm', async () => {
      // Act
      const result = await packBundle({ entry, base: projDir, hosts })

      // Assert
      expect([...result.bundle.keys()]).toContain('/node_modules/esm-dep/extra.mjs')
      expect(readFile(result.bundle, '/node_modules/esm-dep/extra.mjs')).toBe("export default 'extra-loaded'\n")
      expect((JSON.parse(readFile(result.bundle, '/node_modules/esm-dep/package.json')) as { type?: string }).type).toBe('module')
      expect(result.containsEsm).toBe(true)
      expect(result.esmToCjs).toBeNull()
    })
  })

  describe('addon resolution', () => {
    it('should record linked: addon hrefs per host family by default', async () => {
      // Act
      const result = await packBundle({ entry, base: projDir, hosts })

      // Assert
      expect(result.addons).toEqual([
        'linked:libnative-dep.1.2.3.so',
        'linked:native-dep.1.2.3.framework/native-dep.1.2.3'
      ])
      expect(result.bundle.addons).toEqual(result.addons)
    })

    it('should resolve an addon listed in builtins to a builtin: href instead of linking it', async () => {
      // Act
      const result = await packBundle({ entry, base: projDir, hosts, builtins: [{ addon: 'native-dep' }] })

      // Assert — the href carries the packed package's version: the host must embed that one
      expect(result.addons).toEqual(['builtin:native-dep@1.2.3'])
      // The addon's JavaScript is still packed; only the native part comes from the host.
      expect([...result.bundle.keys()]).toContain('/node_modules/native-dep/index.js')
      // Nothing is left for bare-link to produce.
      expect(discoverLinkedAddons(result.bundle, projDir)).toEqual([])
    })
  })

  describe('resolution failures', () => {
    it('should throw MissingModuleError naming the specifier for an unresolvable import', async () => {
      // Arrange
      const broken = path.join(projDir, 'broken.js')
      fs.writeFileSync(broken, "require('not-installed-pkg')\n")

      // Act
      const act = packBundle({ entry: broken, base: projDir, hosts })

      // Assert
      await expect(act).rejects.toBeInstanceOf(MissingModuleError)
      await expect(act).rejects.toMatchObject({ missingModule: 'not-installed-pkg' })
    })

    it('should record a deferred specifier instead of failing', async () => {
      // Arrange
      const deferring = path.join(projDir, 'deferring.js')
      fs.writeFileSync(deferring, "module.exports = () => require('optional-peer')\n")

      // Act
      const result = await packBundle({ entry: deferring, base: projDir, hosts, defer: ['optional-peer'] })

      // Assert
      const resolutions = result.bundle.resolutions as Record<string, Record<string, string>>
      expect(resolutions['/deferring.js']['optional-peer']).toBe('deferred:optional-peer')
    })
  })

  describe('writeBundleFile', () => {
    const cases: Array<{ outName: string, expectedPrefix: string }> = [
      { outName: 'raw.bundle', expectedPrefix: '' },
      { outName: 'app.bundle.js', expectedPrefix: 'module.exports = "' },
      { outName: 'app.bundle.cjs', expectedPrefix: 'module.exports = "' },
      { outName: 'app.bundle.mjs', expectedPrefix: 'export default "' },
      { outName: 'app.bundle.json', expectedPrefix: '"' }
    ]

    it.each(cases)('should write $outName in the wrapper bare-pack uses for that extension and read it back', async ({ outName, expectedPrefix }) => {
      // Arrange
      const { bundle } = await packBundle({ entry, base: projDir, hosts, convertEsmToCjs: true })
      const out = path.join(projDir, 'out', outName)

      // Act
      const written = writeBundleFile(out, bundle)

      // Assert
      const onDisk = fs.readFileSync(out)
      expect(onDisk.equals(written)).toBe(true)
      expect(onDisk.subarray(0, expectedPrefix.length).toString()).toBe(expectedPrefix)
      const reread = readBundle(out)
      expect([...reread.keys()].sort()).toEqual([...bundle.keys()].sort())
      expect(reread.id).toBe(bundle.id)
      expect(Buffer.from(reread.toBuffer()).equals(Buffer.from(bundle.toBuffer()))).toBe(true)
    })
  })
})
