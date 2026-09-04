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
      resolvedOutput: {
        bundle: bundlePath,
        types: path.join(projectRoot, '.wdk/index.d.ts'),
        addons: {
          ios: path.join(projectRoot, 'ios-addons'),
          macos: path.join(projectRoot, 'mac-addons'),
          android: path.join(projectRoot, 'android-addons')
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
    const result = await linkAddons(config, { platforms: ['ios', 'android'], silent: true })

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
        { name: 'bare-fs', version: '4.7.4', dir: bareFsDir, artefacts: ['bare-fs.4.7.4.framework', 'libbare-fs.4.7.4.so'] },
        { name: 'sodium-native', version: '5.1.0', dir: sodiumDir, artefacts: ['libsodium-native.5.1.0.so', 'sodium-native.5.1.0.framework'] }
      ]
    })
    expect(fs.existsSync(config.resolvedOutput.addons.ios)).toBe(true)
    expect(fs.existsSync(config.resolvedOutput.addons.android)).toBe(true)
  })

  it('should fail when bare-link writes no artefact for an addon the header promises', async () => {
    // Arrange: sodium-native ships no Android prebuilds in this tree
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['libbare-fs.4.7.4.so'],
      [sodiumDir]: []
    }))

    // Act
    const result = await linkAddons(config, { platforms: ['android'], silent: true })

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
    mockLink.mockImplementation(linkYielding({
      [bareFsDir]: ['bare-fs.4.7.4.framework'],
      [sodiumDir]: []
    }))

    // Act
    const result = await linkAddons(config, { platforms: ['macos'], silent: true })

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

  it('should not report gaps for a platform family the bundle was not packed for', async () => {
    // Arrange: an Android-only pack carries no .framework promises to check iOS against
    const bundle = new Bundle()
    bundle.write('/node_modules/bare-fs/package.json', JSON.stringify({ name: 'bare-fs', version: '4.7.4', addon: true }))
    bundle.addons = ['linked:libbare-fs.4.7.4.so']
    fs.writeFileSync(config.resolvedOutput.bundle, bundle.toBuffer())
    mockLink.mockImplementation(linkYielding({}))

    // Act
    const result = await linkAddons(config, { platforms: ['ios'], silent: true })

    // Assert
    expect(mockLink.mock.calls).toEqual([
      [bareFsDir, { hosts: IOS_HOSTS, out: config.resolvedOutput.addons.ios }]
    ])
    expect(result.success).toBe(true)
  })

  it('should fail without linking when the bundle has not been generated yet', async () => {
    // Arrange
    fs.rmSync(config.resolvedOutput.bundle)

    // Act
    const result = await linkAddons(config, { platforms: ['android'], silent: true })

    // Assert
    expect(mockLink).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.addons).toEqual([])
    expect(result.error).toContain(`ENOENT: no such file or directory, open '${config.resolvedOutput.bundle}'`)
  })
})
