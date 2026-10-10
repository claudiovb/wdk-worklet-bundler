import fs from 'fs'
import os from 'os'
import path from 'path'
import Bundle from 'bare-bundle'
import { createBundle, wrapBundle } from '../helpers/bundle'
import { unwrapBundle, rewrapBundle, readBundle, wrapperForPath, writeBundleFile, type BundleWrapper } from '../../src/bundler/bundle-file'

/** Content is irrelevant here: these tests are about bytes, not conversion. */
const RAW_BUNDLE = createBundle({
  '/node_modules/pkg/package.json': '{"name":"pkg","version":"1.0.0"}',
  '/node_modules/pkg/index.js': 'module.exports = 1'
})

const WRAPPER_KINDS: Array<{ kind: BundleWrapper }> = [
  { kind: 'cjs' },
  { kind: 'mjs' },
  { kind: 'json' }
]

describe('bundle-file', () => {
  describe('unwrapBundle', () => {
    it.each(WRAPPER_KINDS)('should return the $kind wrapper and the raw bundle bytes', ({ kind }) => {
      // Arrange: the wrapped shape comes from the helper, not from rewrapBundle
      const wrapped = wrapBundle(kind, RAW_BUNDLE)

      // Act
      const result = unwrapBundle(wrapped)

      // Assert
      expect(result).toEqual({ wrapper: kind, bundle: RAW_BUNDLE })
    })

    it('should return no wrapper and the same buffer for a raw bundle', () => {
      // Act
      const result = unwrapBundle(RAW_BUNDLE)

      // Assert
      expect(result).toEqual({ wrapper: null, bundle: RAW_BUNDLE })
      expect(result.bundle).toBe(RAW_BUNDLE)
    })
  })

  describe('wrapperForPath', () => {
    it.each([
      { outputPath: '/out/wdk-worklet.bundle', wrapper: null },
      { outputPath: '/out/wdk-worklet.mobile.bundle', wrapper: null },
      { outputPath: '/out/wdk-worklet', wrapper: null },
      { outputPath: '/out/wdk-worklet.bundle.js', wrapper: 'cjs' },
      { outputPath: '/out/wdk-worklet.bundle.cjs', wrapper: 'cjs' },
      { outputPath: '/out/wdk-worklet.bundle.mjs', wrapper: 'mjs' },
      { outputPath: '/out/wdk-worklet.bundle.json', wrapper: 'json' },
      { outputPath: '/out/wdk-worklet.js', wrapper: null }
    ])('should pick $wrapper for $outputPath, as the bare-pack CLI does', ({ outputPath, wrapper }) => {
      expect(wrapperForPath(outputPath)).toBe(wrapper)
    })
  })

  describe('writeBundleFile', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-write-bundle-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it.each([
      { ext: 'bundle', kind: null },
      { ext: 'bundle.js', kind: 'cjs' as const },
      { ext: 'bundle.mjs', kind: 'mjs' as const },
      { ext: 'bundle.json', kind: 'json' as const }
    ])('should write a .$ext output in its wrapper, creating the directory, and return the bytes', ({ ext, kind }) => {
      // Arrange
      const bundle = new Bundle()
      bundle.write('/index.js', 'module.exports = 1', { main: true })
      const outputPath = path.join(tempDir, 'nested', `app.${ext}`)
      const raw = Buffer.from(bundle.toBuffer())

      // Act
      const written = writeBundleFile(outputPath, bundle)

      // Assert
      const expected = kind === null ? raw : wrapBundle(kind, raw)
      expect(written).toEqual(expected)
      expect(fs.readFileSync(outputPath)).toEqual(expected)
      expect([...readBundle(outputPath).keys()]).toEqual(['/index.js'])
    })
  })

  describe('rewrapBundle', () => {
    it.each(WRAPPER_KINDS)('should produce the exact bytes bare-pack writes for a $kind output', ({ kind }) => {
      // Act
      const rewrapped = rewrapBundle(kind, RAW_BUNDLE)

      // Assert
      expect(rewrapped).toEqual(wrapBundle(kind, RAW_BUNDLE))
    })

    it('should return the same buffer when there is no wrapper', () => {
      // Act
      const rewrapped = rewrapBundle(null, RAW_BUNDLE)

      // Assert
      expect(rewrapped).toBe(RAW_BUNDLE)
    })
  })

  describe('readBundle', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-bundle-file-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it('should parse a wrapped artifact into a bundle with its files and header', () => {
      // Arrange: a real bare-bundle header, wrapped the way the hrpc default output is
      const bundle = new Bundle()
      bundle.write('/entry.js', 'module.exports = 42', { main: true })
      bundle.write('/node_modules/bare-fs/package.json', '{"name":"bare-fs","version":"4.7.4","addon":true}')
      bundle.addons = ['linked:libbare-fs.4.7.4.so']
      const bundlePath = path.join(tempDir, 'wdk-worklet.bundle.js')
      fs.writeFileSync(bundlePath, wrapBundle('cjs', Buffer.from(bundle.toBuffer())))

      // Act
      const parsed = readBundle(bundlePath)

      // Assert
      expect([...parsed.keys()]).toEqual(['/entry.js', '/node_modules/bare-fs/package.json'])
      expect(parsed.main).toBe('/entry.js')
      expect(parsed.addons).toEqual(['linked:libbare-fs.4.7.4.so'])
      expect(parsed.read('/entry.js').toString()).toBe('module.exports = 42')
    })

    it('should throw ENOENT when the bundle has not been generated yet', () => {
      // Arrange
      const missingPath = path.join(tempDir, 'missing.bundle')

      // Act & Assert
      expect(() => readBundle(missingPath)).toThrow(`ENOENT: no such file or directory, open '${missingPath}'`)
    })
  })
})
