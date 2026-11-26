/**
 * Integration test: pack a fixture project through the REAL bare-stow
 * (stowBundle) and verify what it wrote: the host package, the bundle inside
 * it, and, for a converted bundle, that it executes under a CJS-only module
 * loader (what a JSC/QuickJS worklet effectively is).
 *
 * Nothing here reimplements bare-stow's output: the package layout, the bundle
 * header, the resolutions and the addon hrefs all come from bare-stow itself,
 * so a bare-stow change breaks this test instead of silently diverging from
 * our assumptions. Only the two packages a stowed bundle always needs are
 * stand-ins (see tests/helpers/stow-fixture.ts); the real pear-wrk-wdk runs
 * in the smoke test.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { pathToFileURL } from 'url'
import type Bundle from 'bare-bundle'
import { stowBundle, type StowBundleOptions } from '../../src/bundler/stow'
import { readBundleFile, readStowedBundle, standInServerSource, writeFixtureFile, writeStandInPackages } from '../helpers/stow-fixture'

type ModuleFactory = (
  module: { exports: unknown },
  exports: unknown,
  require: (spec: string) => unknown,
  filename: string,
  dirname: string
) => void

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
      cache[file] = { exports: JSON.parse(readBundleFile(bundle, file)) as unknown }
      return cache[file].exports
    }
    const mod: { exports: unknown } = { exports: {} }
    cache[file] = mod
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', readBundleFile(bundle, file)) as ModuleFactory
    fn(mod, mod.exports, (s: string) => requireFile(resolve(s, file)), file, path.posix.dirname(file))
    return mod.exports
  }
  return requireFile
}

describe('stowBundle against the real bare-stow', () => {
  let tempDir: string
  let projDir: string
  let entry: string
  let outCount = 0

  /** Options of a Swift package served over hrpc (no client), for one iOS host. */
  const swift = (overrides: Partial<StowBundleOptions> = {}): StowBundleOptions => ({
    entry,
    out: path.join(tempDir, `out-${outCount++}`, 'wdk-worklet'),
    projectRoot: projDir,
    target: 'bare-kit',
    language: { name: 'swift' },
    transport: 'hrpc',
    hosts: ['ios-arm64'],
    ...overrides
  })

  const relativeFiles = (out: string, files: string[]): string[] =>
    files.map((file) => path.relative(out, file).split(path.sep).join('/'))

  beforeAll(() => {
    // realpath: bare-stow names the modules by their real paths.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-stow-bundle-')))
    projDir = path.join(tempDir, 'proj')
    entry = path.join(projDir, 'entry.js')

    writeStandInPackages(projDir)

    // Fixture: CJS entry -> ESM package ("type": "module") -> dynamic import
    // of an .mjs file.
    writeFixtureFile(projDir, 'node_modules/esm-dep/package.json', JSON.stringify({
      name: 'esm-dep', version: '1.0.0', type: 'module', main: 'index.js'
    }))
    writeFixtureFile(projDir, 'node_modules/esm-dep/index.js',
      "export async function lazy () { return (await import('./extra.mjs')).default }\n" +
      'export const value = 42\n')
    writeFixtureFile(projDir, 'node_modules/esm-dep/extra.mjs', "export default 'extra-loaded'\n")

    writeFixtureFile(projDir, 'entry.js',
      "const dep = require('esm-dep')\n" +
      'exports.dep = dep\n')
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('the host package', () => {
    it('should write a Swift package named after the output folder, with the bare-rpc client', async () => {
      // Arrange
      const options = swift({ transport: 'bare-rpc' })

      // Act
      const result = await stowBundle(options)

      // Assert
      expect(relativeFiles(options.out, result.files)).toEqual([
        'Sources/WdkWorklet/Harness.swift',
        'Sources/WdkWorklet/Client.swift',
        'Package.swift',
        'Sources/WdkWorklet/index.bundle'
      ])
      expect(result.bundlePath).toBe(path.join(options.out, 'Sources/WdkWorklet/index.bundle'))
      expect(result.files.every((file) => fs.statSync(file).size > 0)).toBe(true)
      expect(fs.readFileSync(path.join(options.out, 'Package.swift'), 'utf-8')).toContain('.library(name: "WdkWorklet", targets: ["WdkWorklet"])')
    })

    it('should write a Swift package without a client for the hrpc transport', async () => {
      // Arrange
      const options = swift({ transport: 'hrpc' })

      // Act
      const result = await stowBundle(options)

      // Assert
      expect(relativeFiles(options.out, result.files)).toEqual([
        'Sources/WdkWorklet/Harness.swift',
        'Package.swift',
        'Sources/WdkWorklet/index.bundle'
      ])
    })

    it('should write a Kotlin module under the given package, with the bare-rpc client', async () => {
      // Arrange
      const options = swift({
        language: { name: 'kotlin', package: 'to.tether.wdk.worklet' },
        transport: 'bare-rpc',
        hosts: ['android-arm64']
      })

      // Act
      const result = await stowBundle(options)

      // Assert
      expect(relativeFiles(options.out, result.files)).toEqual([
        'src/main/kotlin/to/tether/wdk/worklet/Harness.kt',
        'src/main/kotlin/to/tether/wdk/worklet/Client.kt',
        'build.gradle',
        'src/main/assets/to/tether/wdk/worklet/index.bundle'
      ])
      expect(fs.readFileSync(path.join(options.out, 'build.gradle'), 'utf-8')).toContain('namespace = "to.tether.wdk.worklet"')
    })

    it('should pass the engine to the target: tools 5.10 for v8, tools 6.1 with the JavaScriptCore trait otherwise', async () => {
      // Arrange
      const v8 = swift()
      const jsc = swift({ engine: 'javascriptcore', convertEsmToCjs: true })

      // Act
      await stowBundle(v8)
      await stowBundle(jsc)

      // Assert
      const v8Manifest = fs.readFileSync(path.join(v8.out, 'Package.swift'), 'utf-8')
      const jscManifest = fs.readFileSync(path.join(jsc.out, 'Package.swift'), 'utf-8')
      expect(v8Manifest.split('\n')[0]).toBe('// swift-tools-version: 5.10')
      expect(v8Manifest).not.toContain('traits:')
      expect(jscManifest.split('\n')[0]).toBe('// swift-tools-version: 6.1')
      expect(jscManifest).toContain('traits: ["JavaScriptCore"]')
    })

    it('should refuse a host the target does not support for the language', async () => {
      // Act
      const act = stowBundle(swift({ hosts: ['android-arm64'] }))

      // Assert
      await expect(act).rejects.toThrow("Host 'android-arm64' is not supported by target 'bare-kit'")
    })
  })

  describe('the bundle', () => {
    it('should start from bare-stow\'s shim, which loads the server module and the entry', async () => {
      // Act
      const result = await stowBundle(swift())

      // Assert
      const bundle = readStowedBundle(result.bundlePath)
      const resolutions = bundle.resolutions as Record<string, Record<string, string>>
      expect(bundle.main).toBe('/__main__.cjs')
      expect(resolutions['/__main__.cjs']).toEqual({
        './__server__.cjs': '/__server__.cjs',
        './entry.js': '/entry.js',
        'bare-stow-runtime': '/node_modules/bare-stow-runtime/index.js'
      })
    })

    it('should stamp a content-hash id that only changes with the content', async () => {
      // Act
      const a = readStowedBundle((await stowBundle(swift({ convertEsmToCjs: true }))).bundlePath)
      const b = readStowedBundle((await stowBundle(swift({ convertEsmToCjs: true }))).bundlePath)
      const readable = readStowedBundle((await stowBundle(swift({ convertEsmToCjs: true, minify: false }))).bundlePath)

      // Assert
      expect(a.id).toMatch(/^[0-9a-f]{64}$/)
      expect(b.id).toBe(a.id)
      expect(readable.id).not.toBe(a.id)
    })
  })

  describe('the server provider', () => {
    it('should create the hrpc provider with the transport alone', async () => {
      // Act
      const result = await stowBundle(swift({ transport: 'hrpc' }))

      // Assert
      const bundle = readStowedBundle(result.bundlePath)
      expect(readBundleFile(bundle, '/__server__.cjs')).toBe(standInServerSource('hrpc'))
    })

    it('should create the bare-rpc provider with no limits when none are given', async () => {
      // Act
      const result = await stowBundle(swift({ transport: 'bare-rpc' }))

      // Assert
      const bundle = readStowedBundle(result.bundlePath)
      expect(readBundleFile(bundle, '/__server__.cjs')).toBe(standInServerSource('bare-rpc', {}))
    })

    it('should create the bare-rpc provider with the limits given, and only those', async () => {
      // Act
      const result = await stowBundle(swift({ transport: 'bare-rpc', limits: { maxFrameSize: 4194304, maxBufferedBytes: undefined } }))

      // Assert
      const bundle = readStowedBundle(result.bundlePath)
      expect(readBundleFile(bundle, '/__server__.cjs')).toBe(standInServerSource('bare-rpc', { maxFrameSize: 4194304 }))
    })

    it('should fail when the installed pear-wrk-wdk does not export createServerProvider', async () => {
      // Arrange: the LTS line exports only HRPC from its root
      const ltsDir = path.join(tempDir, 'lts-proj')
      writeFixtureFile(ltsDir, 'node_modules/@tetherto/pear-wrk-wdk/package.json',
        JSON.stringify({ name: '@tetherto/pear-wrk-wdk', version: '1.0.0-beta.18', main: 'index.js' }))
      writeFixtureFile(ltsDir, 'node_modules/@tetherto/pear-wrk-wdk/index.js', 'exports.HRPC = class HRPC {}\n')
      writeFixtureFile(ltsDir, 'entry.js', 'module.exports = () => {}\n')

      // Act
      const act = stowBundle(swift({ entry: path.join(ltsDir, 'entry.js'), projectRoot: ltsDir }))

      // Assert
      await expect(act).rejects.toThrow(
        `The @tetherto/pear-wrk-wdk installed in ${ltsDir} does not export createServerProvider, ` +
        'so it cannot serve a bare-stow bundle. Install the RC line of the package: npm install @tetherto/pear-wrk-wdk@github:claudiovb/pear-wrk-wdk#1c72715'
      )
    })

    it('should fail when pear-wrk-wdk is not installed in the project', async () => {
      // Arrange
      const emptyDir = path.join(tempDir, 'empty-proj')
      writeFixtureFile(emptyDir, 'entry.js', 'module.exports = () => {}\n')

      // Act
      const error = await stowBundle(swift({ entry: path.join(emptyDir, 'entry.js'), projectRoot: emptyDir }))
        .then(() => null, (e: unknown) => e as { code: string })

      // Assert
      expect(error).not.toBeNull()
      expect(error!.code).toBe('MODULE_NOT_FOUND')
    })
  })

  describe('with convertEsmToCjs on', () => {
    it('should pack a CJS-only bundle under .js keys that executes', async () => {
      // Act
      const result = await stowBundle(swift({ convertEsmToCjs: true }))

      // Assert — keys, header, counters (each file converted and counted once,
      // however many times bare-stow reads it)
      const bundle = readStowedBundle(result.bundlePath)
      const keys = [...bundle.keys()]
      expect(keys).toEqual([
        '/__main__.cjs',
        '/__server__.cjs',
        '/entry.js',
        '/node_modules/bare-stow-runtime/index.js',
        '/node_modules/bare-stow-runtime/package.json',
        '/node_modules/esm-dep/extra.js',
        '/node_modules/esm-dep/index.js',
        '/node_modules/esm-dep/package.json'
      ])
      expect(JSON.parse(readBundleFile(bundle, '/node_modules/esm-dep/package.json'))).not.toHaveProperty('type')
      expect(result.esmToCjs).toEqual({ converted: 4, packagesPatched: 1 })

      // Assert — no ESM syntax survives
      for (const key of keys.filter(k => /\.(js|cjs)$/.test(k))) {
        const code = readBundleFile(bundle, key)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        expect(() => new Function(code)).not.toThrow()
        expect(code).not.toMatch(/[^.\w]import\s*\(/)
      }

      // Assert — the converted graph runs under a CJS-only loader, across the former .mjs
      const requireFile = makeLoader(bundle)
      const exported = requireFile('/entry.js') as { dep: { value: number, lazy: () => Promise<string> } }
      expect(exported.dep.value).toBe(42)
      await expect(exported.dep.lazy()).resolves.toBe('extra-loaded')
    })
  })

  describe('with convertEsmToCjs off', () => {
    it('should keep ES modules verbatim', async () => {
      // Act
      const result = await stowBundle(swift())

      // Assert
      const bundle = readStowedBundle(result.bundlePath)
      expect([...bundle.keys()]).toContain('/node_modules/esm-dep/extra.mjs')
      expect(readBundleFile(bundle, '/node_modules/esm-dep/extra.mjs')).toBe("export default 'extra-loaded'\n")
      expect((JSON.parse(readBundleFile(bundle, '/node_modules/esm-dep/package.json')) as { type?: string }).type).toBe('module')
      expect(result.esmToCjs).toBeNull()
    })
  })

  describe('resolution failures', () => {
    it('should surface the MODULE_NOT_FOUND error with the specifier and the importing module', async () => {
      // Arrange
      const broken = path.join(projDir, 'broken.js')
      fs.writeFileSync(broken, "require('not-installed-pkg')\n")

      // Act
      const error = await stowBundle(swift({ entry: broken })).then(() => null, (e: unknown) => e as { code: string, specifier: string, referrer: URL, message: string })

      // Assert
      expect(error).not.toBeNull()
      expect(error!.code).toBe('MODULE_NOT_FOUND')
      expect(error!.specifier).toBe('not-installed-pkg')
      expect(String(error!.referrer)).toBe(pathToFileURL(broken).href)
      expect(error!.message).toContain("Cannot find module 'not-installed-pkg'")
    })

    it('should record a deferred specifier instead of failing', async () => {
      // Arrange
      const deferring = path.join(projDir, 'deferring.js')
      fs.writeFileSync(deferring, "module.exports = () => require('optional-peer')\n")

      // Act
      const result = await stowBundle(swift({ entry: deferring, defer: ['optional-peer'] }))

      // Assert
      const resolutions = readStowedBundle(result.bundlePath).resolutions as Record<string, Record<string, string>>
      expect(resolutions['/deferring.js']['optional-peer']).toBe('deferred:optional-peer')
    })
  })

  describe('conversion failures', () => {
    const tlaDep = (): void => {
      writeFixtureFile(projDir, 'node_modules/tla-dep/package.json', JSON.stringify({ name: 'tla-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
      writeFixtureFile(projDir, 'node_modules/tla-dep/index.js', 'export const ready = true\nawait Promise.resolve()\n')
    }

    it('should fail the pack with esbuild\'s error naming the file, line and cause', async () => {
      // Arrange: top-level await has no CommonJS lowering for the es2020 target
      tlaDep()
      const tlaEntry = path.join(projDir, 'tla-entry.js')
      fs.writeFileSync(tlaEntry, "module.exports = require('tla-dep')\n")

      // Act
      const act = stowBundle(swift({ entry: tlaEntry, convertEsmToCjs: true }))

      // Assert
      await expect(act).rejects.toThrow(
        `${path.join(projDir, 'node_modules/tla-dep/index.js')}:2:0: ERROR: Top-level await is not available in the configured target environment ("es2020" + 1 override)`
      )
    })

    it('should report the conversion failure of a module before resolving its own imports', async () => {
      // Arrange: the module both fails to convert and imports something that does not resolve
      writeFixtureFile(projDir, 'node_modules/tla-missing-dep/package.json', JSON.stringify({ name: 'tla-missing-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
      writeFixtureFile(projDir, 'node_modules/tla-missing-dep/index.js', "import 'not-installed-anywhere'\nawait Promise.resolve()\nexport const x = 1\n")
      const bothEntry = path.join(projDir, 'tla-and-missing.js')
      fs.writeFileSync(bothEntry, "module.exports = require('tla-missing-dep')\n")

      // Act
      const act = stowBundle(swift({ entry: bothEntry, convertEsmToCjs: true }))

      // Assert
      await expect(act).rejects.toThrow(/tla-missing-dep\/index\.js:2:0: ERROR: Top-level await/)
      await expect(act).rejects.not.toMatchObject({ code: 'MODULE_NOT_FOUND' })
    })
  })
})
