/**
 * Integration test: generateBundle from a resolved config to the package on
 * disk, through the real entry generator and the real bare-stow. The project
 * is a fixture of stand-in packages (see tests/helpers/stow-fixture.ts), so
 * nothing is installed and nothing runs.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { generateBundle } from '../../src/bundler'
import type { ResolvedConfig } from '../../src/config/types'
import { listFiles, readBundleFile, readStowedBundle, standInServerSource, writeFixtureFile, writeStandInWdkProject } from '../helpers/stow-fixture'

describe('generateBundle', () => {
  let tempDir: string
  let projDir: string
  let outCount = 0

  /** A Swift config over bare-rpc for one iOS host, with its own output folder. */
  const makeConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    transport: 'bare-rpc',
    language: 'swift',
    networks: { ethereum: { package: '@tetherto/wdk-wallet-evm' } },
    options: { targets: ['ios-arm64'] },
    configPath: path.join(projDir, 'wdk.config.js'),
    projectRoot: projDir,
    outputDir: path.join(tempDir, `out-${outCount++}`, 'wdk-worklet'),
    ...overrides
  })

  const relativeFiles = (outputDir: string, files: string[]): string[] =>
    files.map((file) => path.relative(outputDir, file).split(path.sep).join('/'))

  beforeAll(() => {
    // realpath: bare-stow names the modules by their real paths.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-generate-bundle-')))
    projDir = path.join(tempDir, 'proj')
    writeStandInWdkProject(projDir)
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should write the Swift package and report where it is', async () => {
    // Arrange
    const config = makeConfig()

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    const bundlePath = path.join(config.outputDir, 'Sources/WdkWorklet/index.bundle')
    expect(result).toEqual({
      success: true,
      outputDir: config.outputDir,
      bundlePath,
      bundleSize: fs.statSync(bundlePath).size,
      files: [
        path.join(config.outputDir, 'Sources/WdkWorklet/Harness.swift'),
        path.join(config.outputDir, 'Sources/WdkWorklet/Client.swift'),
        path.join(config.outputDir, 'Package.swift'),
        bundlePath
      ],
      esmToCjs: null,
      duration: result.duration
    })
    expect(result.bundleSize).toBeGreaterThan(0)
    const bundle = readStowedBundle(bundlePath)
    expect([...bundle.keys()]).toContain('/.wdk/wdk-worklet.generated.js')
    expect([...bundle.keys()]).toContain('/node_modules/@tetherto/wdk-wallet-evm/index.js')
  })

  it('should write the Kotlin module under the default Kotlin package', async () => {
    // Arrange
    const config = makeConfig({ language: 'kotlin', options: { targets: ['android-arm64'] } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(relativeFiles(config.outputDir, result.files)).toEqual([
      'src/main/kotlin/to/tether/wdk/worklet/Harness.kt',
      'src/main/kotlin/to/tether/wdk/worklet/Client.kt',
      'build.gradle',
      'src/main/assets/to/tether/wdk/worklet/index.bundle'
    ])
    expect(fs.readFileSync(path.join(config.outputDir, 'build.gradle'), 'utf-8')).toContain('  namespace = "to.tether.wdk.worklet"\n')
  })

  it('should write the Kotlin module under the Kotlin package of the config', async () => {
    // Arrange
    const config = makeConfig({ language: 'kotlin', kotlinPackage: 'com.example.wallet', options: { targets: ['android-arm64'] } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(relativeFiles(config.outputDir, result.files)).toEqual([
      'src/main/kotlin/com/example/wallet/Harness.kt',
      'src/main/kotlin/com/example/wallet/Client.kt',
      'build.gradle',
      'src/main/assets/com/example/wallet/index.bundle'
    ])
    expect(fs.readFileSync(path.join(config.outputDir, 'build.gradle'), 'utf-8')).toContain('  namespace = "com.example.wallet"\n')
  })

  it('should not use the Kotlin package with swift', async () => {
    // Arrange
    const config = makeConfig({ kotlinPackage: 'com.example.wallet' })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(relativeFiles(config.outputDir, result.files)).toEqual([
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/Client.swift',
      'Package.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
  })

  it('should write no client for the hrpc transport and create its provider without limits', async () => {
    // Arrange
    const config = makeConfig({ transport: 'hrpc' })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(relativeFiles(config.outputDir, result.files)).toEqual([
      'Sources/WdkWorklet/Harness.swift',
      'Package.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
    expect(readBundleFile(readStowedBundle(result.bundlePath), '/.wdk/__server__.cjs')).toBe(standInServerSource('hrpc'))
  })

  it('should replace the package of an earlier run, leaving none of its files', async () => {
    // Arrange: a bare-rpc package, which has a client the hrpc one does not
    const config = makeConfig()
    await generateBundle(config, { silent: true })

    // Act
    const result = await generateBundle({ ...config, transport: 'hrpc' }, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.wdk-worklet-bundler',
      'Package.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
  })

  it('should write into an output folder that exists and is empty, and list what it wrote in the marker file', async () => {
    // Arrange
    const config = makeConfig()
    fs.mkdirSync(config.outputDir, { recursive: true })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.wdk-worklet-bundler',
      'Package.swift',
      'Sources/WdkWorklet/Client.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
    expect(fs.readFileSync(path.join(config.outputDir, '.wdk-worklet-bundler'), 'utf-8')).toBe(
      '# Generated by @tetherto/wdk-worklet-bundler. `generate` deletes what is listed here and writes the package again on every run.\n' +
      'Sources/WdkWorklet/Harness.swift\n' +
      'Sources/WdkWorklet/Client.swift\n' +
      'Package.swift\n' +
      'Sources/WdkWorklet/index.bundle\n'
    )
  })

  it('should write into an output folder that holds only the .DS_Store of macOS, and keep it', async () => {
    // Arrange
    const config = makeConfig()
    writeFixtureFile(config.outputDir, '.DS_Store', 'finder')

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.DS_Store',
      '.wdk-worklet-bundler',
      'Package.swift',
      'Sources/WdkWorklet/Client.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
    expect(fs.readFileSync(path.join(config.outputDir, '.DS_Store'), 'utf-8')).toBe('finder')
  })

  it('should not use an output folder holding files it did not write', async () => {
    // Arrange
    const config = makeConfig()
    writeFixtureFile(config.outputDir, 'App.swift', 'let app = 1\n')

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      `The output folder ${config.outputDir} holds files that generate did not write, so it is not used. ` +
      "Point 'output' to a folder of its own, or empty this one."
    )
    expect(listFiles(config.outputDir)).toEqual(['App.swift'])
    expect(fs.readFileSync(path.join(config.outputDir, 'App.swift'), 'utf-8')).toBe('let app = 1\n')
  })

  it('should keep the files the user added to a generated package', async () => {
    // Arrange: a generated package, then files of the user in and beside its folders
    const config = makeConfig()
    await generateBundle(config, { silent: true })
    writeFixtureFile(config.outputDir, 'README.md', '# Mine\n')
    writeFixtureFile(config.outputDir, '.git/HEAD', 'ref: refs/heads/main\n')
    writeFixtureFile(config.outputDir, 'Sources/WdkWorklet/Extra.swift', 'let extra = 1\n')

    // Act
    const result = await generateBundle({ ...config, transport: 'hrpc' }, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.git/HEAD',
      '.wdk-worklet-bundler',
      'Package.swift',
      'README.md',
      'Sources/WdkWorklet/Extra.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
    expect(fs.readFileSync(path.join(config.outputDir, 'README.md'), 'utf-8')).toBe('# Mine\n')
    expect(fs.readFileSync(path.join(config.outputDir, '.git/HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n')
    expect(fs.readFileSync(path.join(config.outputDir, 'Sources/WdkWorklet/Extra.swift'), 'utf-8')).toBe('let extra = 1\n')
  })

  it('should remove a listed folder with everything in it, and the folders that leaves empty', async () => {
    // Arrange: what a run for other hosts would have left, and one file of the user
    const config = makeConfig()
    writeFixtureFile(config.outputDir, '.wdk-worklet-bundler',
      '# Generated\nFrameworks/old.1.0.0.xcframework\nsrc/main/addons/x86/libold.1.0.0.so\n')
    writeFixtureFile(config.outputDir, 'Frameworks/old.1.0.0.xcframework/Info.plist', '<plist/>\n')
    writeFixtureFile(config.outputDir, 'Frameworks/old.1.0.0.xcframework/ios-arm64/old.framework/old', 'binary')
    writeFixtureFile(config.outputDir, 'src/main/addons/x86/libold.1.0.0.so', 'binary')
    writeFixtureFile(config.outputDir, 'src/main/notes.txt', 'mine\n')

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.wdk-worklet-bundler',
      'Package.swift',
      'Sources/WdkWorklet/Client.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle',
      'src/main/notes.txt'
    ])
    expect(fs.existsSync(path.join(config.outputDir, 'Frameworks'))).toBe(false)
    expect(fs.existsSync(path.join(config.outputDir, 'src/main/addons'))).toBe(false)
  })

  it('should not delete outside the package folder, whatever the marker file lists', async () => {
    // Arrange: a marker file that points out of the folder with `..`, through
    // a link and with an absolute path
    const config = makeConfig()
    const outsideDir = path.join(path.dirname(config.outputDir), 'outside')
    const outsideFile = path.join(outsideDir, 'kept.txt')
    writeFixtureFile(outsideDir, 'kept.txt', 'kept\n')
    writeFixtureFile(config.outputDir, '.wdk-worklet-bundler', `../outside/kept.txt\nlink/kept.txt\n${outsideFile}\n..\n`)
    fs.symlinkSync(outsideDir, path.join(config.outputDir, 'link'))

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(true)
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('kept\n')
    expect(fs.readlinkSync(path.join(config.outputDir, 'link'))).toBe(outsideDir)
  })

  it('should leave only the marker file and the files of the user when a later run fails, and generate again after it', async () => {
    // Arrange
    const config = makeConfig()
    await generateBundle(config, { silent: true })
    writeFixtureFile(config.outputDir, 'README.md', '# Mine\n')

    // Act
    const failed = await generateBundle({ ...config, networks: { solana: { package: 'wallet-not-installed' } } }, { silent: true })
    const filesAfterFailure = listFiles(config.outputDir)
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(failed.success).toBe(false)
    expect(filesAfterFailure).toEqual(['.wdk-worklet-bundler', 'README.md'])
    expect(result.success).toBe(true)
    expect(listFiles(config.outputDir)).toEqual([
      '.wdk-worklet-bundler',
      'Package.swift',
      'README.md',
      'Sources/WdkWorklet/Client.swift',
      'Sources/WdkWorklet/Harness.swift',
      'Sources/WdkWorklet/index.bundle'
    ])
  })

  it('should give the frame limits of the config to the bare-rpc provider', async () => {
    // Arrange
    const config = makeConfig({ options: { targets: ['ios-arm64'], maxFrameSize: 4194304, maxBufferedBytes: 8388608 } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(readBundleFile(readStowedBundle(result.bundlePath), '/.wdk/__server__.cjs'))
      .toBe(standInServerSource('bare-rpc', { maxFrameSize: 4194304, maxBufferedBytes: 8388608 }))
  })

  it('should convert to CommonJS by default with the javascriptcore engine, and ask bare-stow for it', async () => {
    // Arrange
    const config = makeConfig({ options: { targets: ['ios-arm64'], engine: 'javascriptcore' } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert: the entry, the WDK, the wallet, the worklet entry of pear-wrk-wdk,
    // the runtime's global and the stow runtime are the six modules converted
    expect(result.esmToCjs).toEqual({ converted: 6, packagesPatched: 0 })
    expect(fs.readFileSync(path.join(config.outputDir, 'Package.swift'), 'utf-8').split('\n')[0]).toBe('// swift-tools-version: 6.1')
  })

  it('should defer a missing optional peer by default, and fail on it when told not to defer', async () => {
    // Arrange: a wallet whose optional peer is not installed
    writeFixtureFile(projDir, 'node_modules/wallet-with-optional-peer/package.json', JSON.stringify({
      name: 'wallet-with-optional-peer',
      version: '0.0.0',
      main: 'index.js',
      peerDependencies: { 'optional-peer': '*' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } }
    }))
    writeFixtureFile(projDir, 'node_modules/wallet-with-optional-peer/index.js', "module.exports = () => require('optional-peer')\n")
    const networks = { ledger: { package: 'wallet-with-optional-peer' } }

    // Act
    const deferred = await generateBundle(makeConfig({ networks }), { silent: true })
    const strict = await generateBundle(makeConfig({ networks }), { silent: true, deferOptionalPeers: false })

    // Assert
    const resolutions = readStowedBundle(deferred.bundlePath).resolutions as Record<string, Record<string, string>>
    expect(deferred.success).toBe(true)
    expect(resolutions['/node_modules/wallet-with-optional-peer/index.js']['optional-peer']).toBe('deferred:optional-peer')
    expect(strict.success).toBe(false)
    expect(strict.missingModule).toBe('optional-peer')
  })

  it('should report the package that is not installed as the missing module', async () => {
    // Arrange
    const config = makeConfig({ networks: { solana: { package: 'wallet-not-installed' } } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.missingModule).toBe('wallet-not-installed')
    expect(result.bundlePath).toBe('')
    expect(result.files).toEqual([])
    expect(fs.existsSync(config.outputDir)).toBe(false)
  })

  it('should report a host the language does not support with bare-stow\'s own message', async () => {
    // Arrange
    const config = makeConfig({ options: { targets: ['android-arm64'] } })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBe("Host 'android-arm64' is not supported by target 'bare-kit'")
  })

  it('should report an output folder that is not a valid Swift module name', async () => {
    // Arrange
    const config = makeConfig({ outputDir: path.join(tempDir, 'out-invalid', '3d-wallet') })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBe("'3dWallet' is not a valid Swift module name")
  })

  it('should report that the installed pear-wrk-wdk is not the RC line', async () => {
    // Arrange: a project whose pear-wrk-wdk exports only HRPC, like the LTS line
    const ltsDir = path.join(tempDir, 'lts-proj')
    writeStandInWdkProject(ltsDir)
    writeFixtureFile(ltsDir, 'node_modules/@tetherto/pear-wrk-wdk/index.js', 'exports.HRPC = class HRPC {}\n')
    const config = makeConfig({ projectRoot: ltsDir, configPath: path.join(ltsDir, 'wdk.config.js') })

    // Act
    const result = await generateBundle(config, { silent: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      `The @tetherto/pear-wrk-wdk installed in ${ltsDir} does not export createServerProvider, ` +
      'so it cannot serve a bare-stow bundle. Install the RC line of the package: npm install @tetherto/pear-wrk-wdk@github:claudiovb/pear-wrk-wdk#1c72715'
    )
  })

  describe('with the real bare-node-runtime installed', () => {
    const FIX = 'Redirect it to bare-wdk-runtime: add "overrides": { "bare-node-runtime": "npm:bare-wdk-runtime@^3.0.1" } to package.json and run npm install.'
    let legacyDir: string

    const makeLegacyConfig = (options: ResolvedConfig['options']): ResolvedConfig =>
      makeConfig({ projectRoot: legacyDir, configPath: path.join(legacyDir, 'wdk.config.js'), options })

    beforeEach(() => {
      legacyDir = path.join(tempDir, `legacy-proj-${outCount}`)
      writeStandInWdkProject(legacyDir)
      writeFixtureFile(legacyDir, 'node_modules/bare-node-runtime/package.json', JSON.stringify({ name: 'bare-node-runtime', version: '1.5.5' }))
    })

    it('should warn and still write the package with the v8 engine', async () => {
      // Arrange
      const config = makeLegacyConfig({ targets: ['ios-arm64'] })
      const logged: string[] = []
      const logSpy = jest.spyOn(console, 'log').mockImplementation((message: string) => { logged.push(message) })

      // Act
      const result = await generateBundle(config)
      logSpy.mockRestore()

      // Assert
      expect(result.success).toBe(true)
      expect(logged).toContain(`  ⚠️  bare-node-runtime is installed (node_modules/bare-node-runtime), so the bundle carries two runtimes. ${FIX}`)
    })

    it.each(['javascriptcore', 'quickjs'] as const)('should stop before writing anything with the %s engine', async (engine) => {
      // Arrange
      const config = makeLegacyConfig({ engine })

      // Act
      const result = await generateBundle(config, { silent: true })

      // Assert
      expect(result.success).toBe(false)
      expect(result.error).toBe(`bare-node-runtime is installed (node_modules/bare-node-runtime) and does not run on the '${engine}' engine. ${FIX}`)
      expect(fs.existsSync(config.outputDir)).toBe(false)
      expect(fs.existsSync(path.join(legacyDir, '.wdk'))).toBe(false)
    })
  })

  it('should not warn about a bare-node-runtime folder that holds bare-wdk-runtime', async () => {
    // Arrange: what the npm override installs
    const redirectedDir = path.join(tempDir, 'redirected-proj')
    writeStandInWdkProject(redirectedDir)
    writeFixtureFile(redirectedDir, 'node_modules/bare-node-runtime/package.json', JSON.stringify({ name: 'bare-wdk-runtime', version: '3.0.1' }))
    const config = makeConfig({ projectRoot: redirectedDir, configPath: path.join(redirectedDir, 'wdk.config.js'), options: { targets: ['ios-arm64'], engine: 'javascriptcore' } })
    const logged: string[] = []
    const logSpy = jest.spyOn(console, 'log').mockImplementation((message: string) => { logged.push(message) })

    // Act
    const result = await generateBundle(config)
    logSpy.mockRestore()

    // Assert
    expect(result.success).toBe(true)
    expect(logged.filter((message) => message.includes('bare-node-runtime'))).toEqual([])
  })

  it('should write nothing on a dry run', async () => {
    // Arrange
    const dryDir = path.join(tempDir, 'dry-proj')
    writeStandInWdkProject(dryDir)
    const config = makeConfig({ projectRoot: dryDir, configPath: path.join(dryDir, 'wdk.config.js') })

    // Act
    const result = await generateBundle(config, { silent: true, dryRun: true })

    // Assert
    expect(result).toEqual({
      success: true,
      outputDir: config.outputDir,
      bundlePath: '',
      bundleSize: 0,
      files: [],
      esmToCjs: null,
      duration: result.duration
    })
    expect(fs.existsSync(config.outputDir)).toBe(false)
    expect(fs.existsSync(path.join(dryDir, '.wdk'))).toBe(false)
  })

  it('should fail with skipGeneration when no entry was generated before', async () => {
    // Arrange
    const freshDir = path.join(tempDir, 'fresh-proj')
    writeStandInWdkProject(freshDir)
    const config = makeConfig({ projectRoot: freshDir, configPath: path.join(freshDir, 'wdk.config.js') })

    // Act
    const result = await generateBundle(config, { silent: true, skipGeneration: true })

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      `Artifacts not found at ${path.join(freshDir, '.wdk', 'wdk-worklet.generated.js')}. Run without --skip-generation first.`
    )
  })
})
