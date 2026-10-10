import path from 'path'
import { pathToFileURL } from 'url'
import Bundle from 'bare-bundle'
import { discoverLinkedAddons, hostsForPlatform, linkPlatformsForHosts } from '../../src/bundler/linked-addons'

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
        artefacts: [{ name: 'bare-fs.4.7.4.framework', family: 'apple' }, { name: 'libbare-fs.4.7.4.so', family: 'elf' }]
      },
      {
        name: 'bare-tty',
        version: '5.1.2',
        dir: path.join(PROJECT_ROOT, 'node_modules/bare-tty'),
        artefacts: [{ name: 'bare-tty.framework', family: 'apple' }, { name: 'libbare-tty.so', family: 'elf' }]
      },
      {
        name: 'mac-only',
        version: '0.3.0',
        dir: path.join(PROJECT_ROOT, 'node_modules/mac-only'),
        artefacts: [{ name: 'libmac-only.0.3.0.dylib', family: 'apple' }]
      },
      {
        name: 'win-only',
        version: '1.0.0',
        dir: path.join(PROJECT_ROOT, 'node_modules/win-only'),
        artefacts: [{ name: 'win-only-1.0.0.dll', family: 'windows' }]
      }
    ])
  })

  it('should match scoped names through the shared mangling and keep prerelease versions intact', () => {
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
      artefacts: [{ name: 'buildonspark__spark-frost-bare-addon.0.0.12-beta.3.framework', family: 'apple' }, { name: 'libbuildonspark__spark-frost-bare-addon.0.0.12-beta.3.so', family: 'elf' }]
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
      artefacts: [{ name: 'libsodium-native.4.3.2.so', family: 'elf' }]
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
      artefacts: [{ name: 'libbare-os.3.9.3.so', family: 'elf' }]
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
      artefacts: [{ name: 'libbare-url.2.4.6.so', family: 'elf' }]
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

  it('should skip builtin: hrefs, which the host runtime embeds, and keep the linked: ones', () => {
    // Arrange: bare-crypto was listed in options.builtins, sodium-native was not
    const bundle = packBundle([
      { key: '/node_modules/bare-crypto/package.json', name: 'bare-crypto', version: '1.15.3', addon: true },
      { key: '/node_modules/sodium-native/package.json', name: 'sodium-native', version: '5.1.0', addon: true }
    ], [
      'builtin:bare-crypto@1.15.3',
      'linked:libsodium-native.5.1.0.so'
    ])

    // Act
    const addons = discoverLinkedAddons(bundle, PROJECT_ROOT)

    // Assert
    expect(addons).toEqual([{
      name: 'sodium-native',
      version: '5.1.0',
      dir: path.join(PROJECT_ROOT, 'node_modules/sodium-native'),
      artefacts: [{ name: 'libsodium-native.5.1.0.so', family: 'elf' }]
    }])
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

describe('linkPlatformsForHosts', () => {
  it('should derive the platforms from the packed hosts in link order, without duplicates', () => {
    // Act
    const platforms = linkPlatformsForHosts(['android-arm64', 'ios-arm64', 'android-x64', 'ios-arm64-simulator'])

    // Assert
    expect(platforms).toEqual(['ios', 'android'])
  })

  it('should map darwin hosts to macOS', () => {
    // Act
    const platforms = linkPlatformsForHosts(['darwin-arm64', 'darwin-x64'])

    // Assert
    expect(platforms).toEqual(['macos'])
  })

  it('should map linux and win32 hosts to their platforms', () => {
    // Act
    const platforms = linkPlatformsForHosts(['win32-x64', 'linux-arm64', 'linux-x64'])

    // Assert
    expect(platforms).toEqual(['linux', 'windows'])
  })

  it('should throw for hosts of a family bare-link does not support', () => {
    // Act & Assert
    expect(() => linkPlatformsForHosts(['ios-arm64', 'freebsd-x64'])).toThrow(
      'Cannot link native addons for hosts freebsd-x64: supported host families are ios-*, darwin-*, android-*, linux-*, win32-*'
    )
  })
})

describe('hostsForPlatform', () => {
  it('should return only the packed hosts of the platform, in their original order', () => {
    // Arrange
    const hosts = ['android-x64', 'ios-arm64-simulator', 'darwin-arm64', 'ios-arm64']

    // Act & Assert
    expect(hostsForPlatform('ios', hosts)).toEqual(['ios-arm64-simulator', 'ios-arm64'])
    expect(hostsForPlatform('macos', hosts)).toEqual(['darwin-arm64'])
    expect(hostsForPlatform('android', hosts)).toEqual(['android-x64'])
  })
})
