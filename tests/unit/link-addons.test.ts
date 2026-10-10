import fs from 'fs'
import os from 'os'
import path from 'path'
import Bundle from 'bare-bundle'
import type { ResolvedConfig } from '../../src/config/types'
import { linkAddons } from '../../src/bundler/addons'

const mockLink = jest.fn()

// bare-link drives lipo/codesign and rewrites ELF binaries — an external tool, mocked here.
jest.mock('bare-link', () => mockLink)

const IOS_HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
const ANDROID_HOSTS = ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']

/** bare-link yields the path of every resource it writes, one artefact per addon here. */
function linkYielding (artefactsByDir: Record<string, string[]>): (dir: string, opts: { out: string }) => AsyncIterable<string> {
  return async function * (dir, opts) {
    await Promise.resolve()
    for (const artefact of artefactsByDir[dir] ?? []) yield path.join(opts.out, artefact)
  }
}

describe('linkAddons', () => {
  let projectRoot: string
  let config: ResolvedConfig
  let bareFsDir: string
  let sodiumDir: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-link-addons-'))
    bareFsDir = path.join(projectRoot, 'node_modules/bare-fs')
    sodiumDir = path.join(projectRoot, 'node_modules/sodium-native')

    const bundle = new Bundle()
    bundle.write('/node_modules/bare-fs/package.json', JSON.stringify({ name: 'bare-fs', version: '4.7.4', addon: true }))
    bundle.write('/node_modules/sodium-native/package.json', JSON.stringify({ name: 'sodium-native', version: '5.1.0', addon: true }))
    bundle.addons = [
      'linked:bare-fs.4.7.4.framework/bare-fs.4.7.4',
      'linked:libbare-fs.4.7.4.so',
      'linked:libsodium-native.5.1.0.so',
      'linked:sodium-native.5.1.0.framework/sodium-native.5.1.0'
    ]
    // The hrpc default output is the module.exports wrapper — linking must see through it.
    const bundlePath = path.join(projectRoot, 'wdk-worklet.bundle.js')
    fs.writeFileSync(bundlePath, `module.exports = ${JSON.stringify(bundle.toBuffer().toString())}\n`)

    config = {
      configPath: path.join(projectRoot, 'wdk.config.js'),
      projectRoot,
      networks: {},
      options: { targets: [...IOS_HOSTS, ...ANDROID_HOSTS] },
      resolvedOutput: {
        bundle: bundlePath,
        types: path.join(projectRoot, '.wdk/index.d.ts'),
        addons: {
          ios: path.join(projectRoot, 'ios-addons'),
          macos: path.join(projectRoot, 'mac-addons'),
          android: path.join(projectRoot, 'android-addons'),
          linux: path.join(projectRoot, 'linux-addons'),
          windows: path.join(projectRoot, 'windows-addons')
        },
        addonsYml: path.join(projectRoot, 'ios-addons/addons.yml')
      }
    }
    mockLink.mockReset()
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('should link every addon the bundle header names, once per platform', async () => {
    // Arrange
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['libbare-fs.4.7.4.so', 'bare-fs.4.7.4.framework'],
      [sodiumDir]: ['libsodium-native.5.1.0.so', 'sodium-native.5.1.0.framework']
    }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: IOS_HOSTS, out: config.resolvedOutput.addons.ios }],
      [sodiumDir, { hosts: IOS_HOSTS, out: config.resolvedOutput.addons.ios }],
      [bareFsDir, { hosts: ANDROID_HOSTS, out: config.resolvedOutput.addons.android }],
      [sodiumDir, { hosts: ANDROID_HOSTS, out: config.resolvedOutput.addons.android }]
    ])
    const { duration, ...outcome } = result
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(outcome).toEqual({
      success: true,
      platforms: ['ios', 'android'],
      addons: [
        { name: 'bare-fs', version: '4.7.4', dir: bareFsDir, artefacts: [{ name: 'bare-fs.4.7.4.framework', family: 'apple' }, { name: 'libbare-fs.4.7.4.so', family: 'elf' }] },
        { name: 'sodium-native', version: '5.1.0', dir: sodiumDir, artefacts: [{ name: 'libsodium-native.5.1.0.so', family: 'elf' }, { name: 'sodium-native.5.1.0.framework', family: 'apple' }] }
      ]
    })
    expect(fs.existsSync(config.resolvedOutput.addons.ios)).toBe(true)
    expect(fs.existsSync(config.resolvedOutput.addons.android)).toBe(true)
  })

  it('should fail when bare-link writes no artefact for an addon the header promises', async () => {
    // Arrange: sodium-native ships no Android prebuilds in this tree
    config.options = { targets: ANDROID_HOSTS }
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['libbare-fs.4.7.4.so'],
      [sodiumDir]: []
    }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'bare-link produced no artefact for addons the bundle requires; the worklet will fail to load them at runtime:\n' +
      '    - android: sodium-native@5.1.0 (no prebuilds for hosts android-arm64, android-arm, android-ia32, android-x64)'
    )
    expect(result.addons.map(a => a.name)).toEqual(['bare-fs', 'sodium-native'])
  })

  it('should check macOS output against the framework names promised for iOS', async () => {
    // Arrange: iOS and macOS frameworks share the <name>.<version>.framework basename;
    // sodium-native ships no darwin prebuilds in this tree
    config.options = { targets: ['darwin-arm64', 'darwin-x64'] }
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['bare-fs.4.7.4.framework'],
      [sodiumDir]: []
    }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: ['darwin-arm64', 'darwin-x64'], out: config.resolvedOutput.addons.macos }],
      [sodiumDir, { hosts: ['darwin-arm64', 'darwin-x64'], out: config.resolvedOutput.addons.macos }]
    ])
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'bare-link produced no artefact for addons the bundle requires; the worklet will fail to load them at runtime:\n' +
      '    - macos: sodium-native@5.1.0 (no prebuilds for hosts darwin-arm64, darwin-x64)'
    )
  })

  it('should link only the platforms derived from the packed hosts, with exactly those hosts', async () => {
    // Arrange: an iOS-device-only pack; the header still carries Android promises from another build
    config.options = { targets: ['ios-arm64'] }
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['bare-fs.4.7.4.framework'],
      [sodiumDir]: ['sodium-native.5.1.0.framework']
    }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: ['ios-arm64'], out: config.resolvedOutput.addons.ios }],
      [sodiumDir, { hosts: ['ios-arm64'], out: config.resolvedOutput.addons.ios }]
    ])
    expect(result.success).toBe(true)
    expect(result.platforms).toEqual(['ios'])
    expect(fs.existsSync(config.resolvedOutput.addons.android)).toBe(false)
    expect(fs.existsSync(config.resolvedOutput.addons.macos)).toBe(false)
  })

  it('should link linux and windows hosts into their own output directories', async () => {
    // Arrange: a desktop pack; the header promises ELF and DLL artefacts
    const bundle = new Bundle()
    bundle.write('/node_modules/bare-fs/package.json', JSON.stringify({ name: 'bare-fs', version: '4.7.4', addon: true }))
    bundle.addons = ['linked:bare-fs-4.7.4.dll', 'linked:libbare-fs.4.7.4.so']
    fs.writeFileSync(config.resolvedOutput.bundle, bundle.toBuffer())
    config.options = { targets: ['linux-x64', 'win32-x64'] }
    mockLink.mockImplementation(linkYielding({ [bareFsDir]: ['libbare-fs.4.7.4.so', 'bare-fs-4.7.4.dll'] }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: ['linux-x64'], out: config.resolvedOutput.addons.linux }],
      [bareFsDir, { hosts: ['win32-x64'], out: config.resolvedOutput.addons.windows }]
    ])
    expect(result.success).toBe(true)
    expect(result.platforms).toEqual(['linux', 'windows'])
    expect(result.addons[0].artefacts).toEqual([
      { name: 'bare-fs-4.7.4.dll', family: 'windows' },
      { name: 'libbare-fs.4.7.4.so', family: 'elf' }
    ])
  })

  it('should fail without linking for hosts of a family bare-link does not support', async () => {
    // Arrange
    config.options = { targets: ['android-arm64', 'freebsd-x64'] }
    mockLink.mockImplementation(linkYielding({}))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.platforms).toEqual([])
    expect(result.error).toBe('Cannot link native addons for hosts freebsd-x64: supported host families are ios-*, darwin-*, android-*, linux-*, win32-*')
  })

  it('should clear stale artefacts from the platform output directory before linking', async () => {
    // Arrange: an earlier build left a library the header no longer requires
    config.options = { targets: ANDROID_HOSTS }
    const staleLib = path.join(config.resolvedOutput.addons.android, 'arm64-v8a/libbare-old.1.0.0.so')
    fs.mkdirSync(path.dirname(staleLib), { recursive: true })
    fs.writeFileSync(staleLib, 'stale')
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['libbare-fs.4.7.4.so'],
      [sodiumDir]: ['libsodium-native.5.1.0.so']
    }))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(fs.existsSync(staleLib)).toBe(false)
    expect(fs.existsSync(config.resolvedOutput.addons.android)).toBe(true)
  })

  it('should refuse to clear an addon output directory that contains the project root', async () => {
    // Arrange: a misconfigured output path pointing at the project itself
    config.options = { targets: ANDROID_HOSTS }
    config.resolvedOutput.addons.android = projectRoot
    mockLink.mockImplementation(linkYielding({}))

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toBe(`Refusing to clear addon output directory ${projectRoot}: it contains the project root ${projectRoot}`)
    expect(fs.existsSync(config.resolvedOutput.bundle)).toBe(true)
  })

  it('should link from the in-memory bundle when given one, without reading the file', async () => {
    // Arrange: the file on disk is gone; only the packed bundle in memory remains
    fs.rmSync(config.resolvedOutput.bundle)
    config.options = { targets: ANDROID_HOSTS }
    const bundle = new Bundle()
    bundle.write('/node_modules/bare-fs/package.json', JSON.stringify({ name: 'bare-fs', version: '4.7.4', addon: true }))
    bundle.addons = ['linked:libbare-fs.4.7.4.so']
    mockLink.mockImplementation(linkYielding({ [bareFsDir]: ['libbare-fs.4.7.4.so'] }))

    // Act
    const result = await linkAddons(config, { silent: true, bundle })

    // Assert
    expect(result.success).toBe(true)
    expect(result.addons.map(a => a.name)).toEqual(['bare-fs'])
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: ANDROID_HOSTS, out: config.resolvedOutput.addons.android }]
    ])
  })

  it('should fail without linking when the bundle has not been generated yet', async () => {
    // Arrange
    config.options = { targets: ANDROID_HOSTS }
    fs.rmSync(config.resolvedOutput.bundle)

    // Act
    const result = await linkAddons(config, { silent: true })

    // Assert
    expect(mockLink).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.addons).toEqual([])
    expect(result.error).toContain(`ENOENT: no such file or directory, open '${config.resolvedOutput.bundle}'`)
  })
})
