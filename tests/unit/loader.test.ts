import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadConfig, shouldConvertEsmToCjs } from '../../src/config/loader'
import type { WdkBundleConfig } from '../../src/config/types'

describe('shouldConvertEsmToCjs', () => {
  const makeConfig = (options: WdkBundleConfig['options']): WdkBundleConfig =>
    ({ transport: 'bare-rpc', language: 'swift', networks: {}, options })

  it.each([
    [undefined, false],
    ['v8', false],
    ['javascriptcore', true],
    ['quickjs', true]
  ] as const)('should default, with engine %s, to %s', (engine, expected) => {
    expect(shouldConvertEsmToCjs(makeConfig({ engine }))).toBe(expected)
  })

  it('should default to false when the config has no options', () => {
    expect(shouldConvertEsmToCjs(makeConfig(undefined))).toBe(false)
  })

  it.each([
    ['v8', true],
    ['quickjs', false]
  ] as const)('should follow an explicit value over the default of engine %s', (engine, convertEsmToCjs) => {
    expect(shouldConvertEsmToCjs(makeConfig({ engine, convertEsmToCjs }))).toBe(convertEsmToCjs)
  })
})

describe('loadConfig', () => {
  let tempDir: string

  const writeConfig = (config: Record<string, unknown>): string => {
    const configPath = path.join(tempDir, 'wdk.config.json')
    fs.writeFileSync(configPath, JSON.stringify(config))
    return configPath
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-loader-test-')))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('should replace the transport of the file with the override', async () => {
    const configPath = writeConfig({ transport: 'hrpc', language: 'swift', networks: { eth: { package: 'pkg' } } })

    const config = await loadConfig(configPath, { transport: 'bare-rpc' })

    expect(config.transport).toBe('bare-rpc')
    expect(config.configPath).toBe(configPath)
    expect(config.projectRoot).toBe(tempDir)
  })

  it('should accept a file without a transport when the override gives one', async () => {
    const configPath = writeConfig({ language: 'swift', networks: { eth: { package: 'pkg' } } })

    const config = await loadConfig(configPath, { transport: 'hrpc' })

    expect(config.transport).toBe('hrpc')
  })

  it('should keep the transport of the file when there is no override', async () => {
    const configPath = writeConfig({ transport: 'hrpc', language: 'swift', networks: { eth: { package: 'pkg' } } })

    const config = await loadConfig(configPath)

    expect(config.transport).toBe('hrpc')
  })

  it('should validate the override like a value of the file', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'kotlin', kotlinPackage: 'to.tether.wdk.worklet', networks: { eth: { package: 'pkg' } } })

    const loading = loadConfig(configPath, { transport: 'hrpc' })

    await expect(loading).rejects.toThrow(
      "Invalid configuration:\n  - /transport: 'hrpc' is not available with language 'kotlin', because there is no HRPC library for Kotlin. Use 'bare-rpc'."
    )
  })

  it('should resolve the default output folder next to the config file', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'swift', networks: { eth: { package: 'pkg' } } })

    const config = await loadConfig(configPath)

    expect(config.outputDir).toBe(path.join(tempDir, 'wdk-worklet'))
  })

  it('should resolve the output folder of the file relative to the config file', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'swift', networks: { eth: { package: 'pkg' } }, output: './generated/WalletWorklet' })

    const config = await loadConfig(configPath)

    expect(config.outputDir).toBe(path.join(tempDir, 'generated', 'WalletWorklet'))
  })

  it('should take the folder of the config file as the project root', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'swift', networks: { eth: { package: 'pkg' } } })

    const config = await loadConfig(configPath)

    expect(config.projectRoot).toBe(tempDir)
  })

  it('should take the project root of the override, relative to the current directory, and keep the output folder next to the config file', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'swift', networks: { eth: { package: 'pkg' } } })
    const appDir = path.join(tempDir, 'app')
    fs.mkdirSync(appDir)

    const config = await loadConfig(configPath, { projectRoot: path.relative(process.cwd(), appDir) })

    expect(config.projectRoot).toBe(appDir)
    expect(config.outputDir).toBe(path.join(tempDir, 'wdk-worklet'))
  })

  it('should fail when the project root of the override does not exist', async () => {
    const configPath = writeConfig({ transport: 'bare-rpc', language: 'swift', networks: { eth: { package: 'pkg' } } })
    const missingDir = path.join(tempDir, 'no-such-folder')

    const loading = loadConfig(configPath, { projectRoot: missingDir })

    await expect(loading).rejects.toThrow(`Project root not found: ${missingDir}`)
  })
})
