import path from 'path'
import { pathToFileURL } from 'url'
import Bundle from 'bare-bundle'
import { discoverLinkedAddons } from '../../src/bundler/linked-addons'

const PROJECT_ROOT = path.resolve('/app')

interface PackedPackage { key: string, name: string, version: string, addon?: boolean }

function packBundle (packages: PackedPackage[], addons: string[]): Bundle {
  const bundle = new Bundle()
  for (const { key, name, version, addon } of packages) {
    bundle.write(key, JSON.stringify({ name, version, ...(addon === undefined ? {} : { addon }) }))
  }
  bundle.addons = addons
  return bundle
}

describe('discoverLinkedAddons', () => {
  it('should map every artefact shape back to its packed addon package', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/bare-fs/package.json', name: 'bare-fs', version: '4.7.4', addon: true },
      { key: '/node_modules/bare-tty/package.json', name: 'bare-tty', version: '5.1.2', addon: true },
      { key: '/node_modules/win-only/package.json', name: 'win-only', version: '1.0.0', addon: true },
      { key: '/node_modules/mac-only/package.json', name: 'mac-only', version: '0.3.0', addon: true }
    ], [
      'linked:bare-fs.4.7.4.framework/bare-fs.4.7.4',
      'linked:bare-tty.framework/bare-tty',
      'linked:libbare-fs.4.7.4.so',
      'linked:libbare-tty.so',
      'linked:libmac-only.0.3.0.dylib',
      'linked:win-only-1.0.0.dll'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([
      {
        name: 'bare-fs',
        version: '4.7.4',
        dir: path.join(PROJECT_ROOT, 'node_modules/bare-fs'),
        artefacts: ['bare-fs.4.7.4.framework', 'libbare-fs.4.7.4.so']
      },
      {
        name: 'bare-tty',
        version: '5.1.2',
        dir: path.join(PROJECT_ROOT, 'node_modules/bare-tty'),
        artefacts: ['bare-tty.framework', 'libbare-tty.so']
      },
      {
        name: 'mac-only',
        version: '0.3.0',
        dir: path.join(PROJECT_ROOT, 'node_modules/mac-only'),
        artefacts: ['libmac-only.0.3.0.dylib']
      },
      {
        name: 'win-only',
        version: '1.0.0',
        dir: path.join(PROJECT_ROOT, 'node_modules/win-only'),
        artefacts: ['win-only-1.0.0.dll']
      }
    ])
  })

  it('should demangle scoped names and keep prerelease versions intact', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/@buildonspark/spark-frost-bare-addon/package.json', name: '@buildonspark/spark-frost-bare-addon', version: '0.0.12-beta.3', addon: true }
    ], [
      'linked:buildonspark__spark-frost-bare-addon.0.0.12-beta.3.framework/buildonspark__spark-frost-bare-addon.0.0.12-beta.3',
      'linked:libbuildonspark__spark-frost-bare-addon.0.0.12-beta.3.so'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([{
      name: '@buildonspark/spark-frost-bare-addon',
      version: '0.0.12-beta.3',
      dir: path.join(PROJECT_ROOT, 'node_modules/@buildonspark/spark-frost-bare-addon'),
      artefacts: [
        'buildonspark__spark-frost-bare-addon.0.0.12-beta.3.framework',
        'libbuildonspark__spark-frost-bare-addon.0.0.12-beta.3.so'
      ]
    }])
  })

  it('should pick the nested copy whose version the header names', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/sodium-native/package.json', name: 'sodium-native', version: '5.1.0', addon: true },
      { key: '/node_modules/legacy-dep/node_modules/sodium-native/package.json', name: 'sodium-native', version: '4.3.2', addon: true }
    ], [
      'linked:libsodium-native.4.3.2.so'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([{
      name: 'sodium-native',
      version: '4.3.2',
      dir: path.join(PROJECT_ROOT, 'node_modules/legacy-dep/node_modules/sodium-native'),
      artefacts: ['libsodium-native.4.3.2.so']
    }])
  })

  it('should resolve a package packed from outside the project root by its file URL', () => {
    // Arrange
    const hoistedDir = path.resolve('/workspace/node_modules/bare-os')
    const bundle = packBundle([
      { key: `${pathToFileURL(hoistedDir).href}/package.json`, name: 'bare-os', version: '3.9.3', addon: true }
    ], [
      'linked:libbare-os.3.9.3.so'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([{
      name: 'bare-os',
      version: '3.9.3',
      dir: hoistedDir,
      artefacts: ['libbare-os.3.9.3.so']
    }])
  })

  it('should ignore packed packages that are not addons or not required as addons', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/bare-posix/package.json', name: 'bare-posix', version: '1.0.0', addon: true },
      { key: '/node_modules/streamx/package.json', name: 'streamx', version: '2.21.0' },
      { key: '/node_modules/bare-url/package.json', name: 'bare-url', version: '2.4.6', addon: true }
    ], [
      'linked:libbare-url.2.4.6.so'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([{
      name: 'bare-url',
      version: '2.4.6',
      dir: path.join(PROJECT_ROOT, 'node_modules/bare-url'),
      artefacts: ['libbare-url.2.4.6.so']
    }])
  })

  it('should return no addons for a bundle without linked artefacts', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/streamx/package.json', name: 'streamx', version: '2.21.0' }
    ], [])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([])
  })

  it('should throw when the header names an addon whose package.json was not packed', () => {
    // Arrange
    const bundle = packBundle([
      { key: '/node_modules/bare-fs/package.json', name: 'bare-fs', version: '4.7.4', addon: true }
    ], [
      'linked:libbare-fs.4.7.5.so'
    ])

    // Act & Assert
    expect(() => discoverLinkedAddons(bundle, PROJECT_ROOT)).toThrow(
      "Bundle header lists addon 'linked:libbare-fs.4.7.5.so' but contains no package.json for bare-fs@4.7.5"
    )
  })

  it('should throw on an artefact shape bare-addon-resolve does not produce', () => {
    // Arrange
    const bundle = packBundle([], ['linked:bare-fs.wasm'])

    // Act & Assert
    expect(() => discoverLinkedAddons(bundle, PROJECT_ROOT)).toThrow(
      "Unrecognised linked addon artefact 'linked:bare-fs.wasm'"
    )
  })
})
