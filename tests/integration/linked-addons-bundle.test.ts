/**
 * Integration test: pack with the REAL bare-pack (JS API, linked resolution)
 * against a fixture project containing native addon packages, and verify the
 * addon set discovered from the resulting bundle header — hrefs, name
 * mangling and package directories all come from bare-pack itself, so a
 * bare-pack or bare-addon-resolve naming change breaks this test instead of
 * silently diverging from our parser.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { readBundle, writeBundleFile } from '../../src/bundler/bundle-file'
import { discoverLinkedAddons } from '../../src/bundler/linked-addons'
import { packBundle } from '../../src/bundler/pack'

describe('discoverLinkedAddons against real bare-pack output', () => {
  let tempDir: string
  let projDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-linked-addons-'))
    projDir = path.join(tempDir, 'proj')

    // Fixture: entry -> plain dep -> addon package, plus a scoped addon
    // package with a prerelease version required directly.
    const writePackage = (dir: string, pkg: Record<string, unknown>, index: string): void => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.js', ...pkg }))
      fs.writeFileSync(path.join(dir, 'index.js'), index)
    }
    writePackage(path.join(projDir, 'node_modules/plain-dep'),
      { name: 'plain-dep', version: '1.0.0' },
      "module.exports = require('native-dep')\n")
    writePackage(path.join(projDir, 'node_modules/native-dep'),
      { name: 'native-dep', version: '1.2.3', addon: true },
      'module.exports = require.addon()\n')
    writePackage(path.join(projDir, 'node_modules/@scope/native'),
      { name: '@scope/native', version: '2.0.0-beta.1', addon: true },
      'module.exports = require.addon()\n')
    fs.writeFileSync(path.join(projDir, 'entry.js'),
      "module.exports = [require('plain-dep'), require('@scope/native')]\n")
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const pack = async (outName: string, hosts: string[]): Promise<string> => {
    const out = path.join(projDir, outName)
    const { bundle } = await packBundle({ entry: path.join(projDir, 'entry.js'), base: projDir, hosts })
    writeBundleFile(out, bundle)
    return out
  }

  it('should discover the addons bare-pack recorded for iOS and Android hosts', async () => {
    // Arrange
    const bundlePath = await pack('app.bundle', ['ios-arm64', 'android-arm64'])

    // Act
    const addons = discoverLinkedAddons(readBundle(bundlePath), projDir)

    // Assert
    expect(addons).toEqual([
      {
        name: '@scope/native',
        version: '2.0.0-beta.1',
        dir: path.join(projDir, 'node_modules/@scope/native'),
        artefacts: [{ name: 'libscope__native.2.0.0-beta.1.so', family: 'elf' }, { name: 'scope__native.2.0.0-beta.1.framework', family: 'apple' }]
      },
      {
        name: 'native-dep',
        version: '1.2.3',
        dir: path.join(projDir, 'node_modules/native-dep'),
        artefacts: [{ name: 'libnative-dep.1.2.3.so', family: 'elf' }, { name: 'native-dep.1.2.3.framework', family: 'apple' }]
      }
    ])
  })

  it('should read the header through the module.exports wrapper of a .bundle.js output', async () => {
    // Arrange
    const bundlePath = await pack('app.bundle.js', ['android-arm64'])

    // Act
    const addons = discoverLinkedAddons(readBundle(bundlePath), projDir)

    // Assert
    expect(addons.map(a => [a.name, a.artefacts.map(x => x.name)])).toEqual([
      ['@scope/native', ['libscope__native.2.0.0-beta.1.so']],
      ['native-dep', ['libnative-dep.1.2.3.so']]
    ])
  })
})
