import fs from 'fs'
import os from 'os'
import path from 'path'
import Bundle from 'bare-bundle'
import { createBundle, wrapBundle } from '../helpers/bundle'
import { unwrapBundle, rewrapBundle, readBundle, type BundleWrapper } from '../../src/bundler/bundle-file'

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
