/**
 * Integration test: prove the actual packing payoff behind
 * generateHandleLeakCheckCode's opt-in design - when options.handleLeakCheck
 * is unset, no require for the diagnostic is emitted, so bare-stow never
 * pulls it (or the bare-walk-handles dependency it drags in) into the
 * packed bundle at all. When it's set, both show up.
 *
 * Uses the real bare-stow (through stowBundle) against a fixture
 * @tetherto/pear-wrk-wdk (its diagnostics/handle-leak-check subpath requires
 * bare-walk-handles, mirroring the real package), so this is exercised
 * through actual dependency resolution rather than a reimplementation of it.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { generateHandleLeakCheckCode } from '../../src/generators/handle-leak-check'
import { stowBundle } from '../../src/bundler/stow'
import type { ResolvedConfig } from '../../src/config/types'
import { readStowedBundle, writeStandInPackages } from '../helpers/stow-fixture'

describe('generateHandleLeakCheckCode against real bare-stow output', () => {
  let tempDir: string
  let projDir: string

  const createMockConfig = (overrides?: Partial<ResolvedConfig>): ResolvedConfig => ({
    transport: 'bare-rpc',
    language: 'swift',
    networks: {},
    protocols: {},
    configPath: path.join(projDir, 'wdk.config.js'),
    projectRoot: projDir,
    outputDir: path.join(projDir, 'wdk-worklet'),
    ...overrides
  })

  beforeAll(() => {
    // realpath: bare-stow names the modules by their real paths.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-handle-leak-bundle-')))
    projDir = path.join(tempDir, 'proj')

    writeStandInPackages(projDir)

    // Fixture @tetherto/pear-wrk-wdk whose diagnostics/handle-leak-check
    // subpath requires bare-walk-handles - the dependency bare-stow should
    // only pull in when the diagnostic is actually required. Its root is the
    // stand-in server provider.
    const pkgDir = path.join(projDir, 'node_modules/@tetherto/pear-wrk-wdk')
    fs.mkdirSync(path.join(pkgDir, 'diagnostics'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@tetherto/pear-wrk-wdk',
      version: '9.9.9',
      exports: {
        '.': './index.js',
        './diagnostics/handle-leak-check': './diagnostics/handle-leak-check.js'
      }
    }))
    fs.writeFileSync(path.join(pkgDir, 'diagnostics/handle-leak-check.js'),
      "const { walkHandles } = require('bare-walk-handles')\n" +
      'module.exports = { registerHandleLeakCheck (opts) { return walkHandles } }\n')

    const walkHandlesDir = path.join(projDir, 'node_modules/bare-walk-handles')
    fs.mkdirSync(walkHandlesDir, { recursive: true })
    fs.writeFileSync(path.join(walkHandlesDir, 'package.json'),
      JSON.stringify({ name: 'bare-walk-handles', version: '1.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(walkHandlesDir, 'index.js'), 'module.exports = { walkHandles () { return [] } }\n')

    fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'fixture-proj', version: '1.0.0' }))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Pack an entry made of the generated code and return the keys of the bundle. */
  const pack = async (entryName: string, generatedCode: string, outName: string): Promise<string[]> => {
    const entry = path.join(projDir, entryName)
    fs.writeFileSync(entry, `${generatedCode}\nmodule.exports = { ok: true }\n`)
    const result = await stowBundle({
      entry,
      out: path.join(tempDir, outName, 'wdk-worklet'),
      projectRoot: projDir,
      target: 'bare-kit',
      language: { name: 'swift' },
      transport: 'hrpc',
      hosts: ['ios-arm64']
    })
    return [...readStowedBundle(result.bundlePath).keys()]
  }

  it('keeps bare-walk-handles and pear-wrk-wdk out of the bundle when handleLeakCheck is unset', async () => {
    const code = generateHandleLeakCheckCode(createMockConfig())
    expect(code).toBe('')

    const files = await pack('entry-off.js', code, 'off')

    expect(files.some(f => f.includes('bare-walk-handles'))).toBe(false)
    expect(files.some(f => f.includes('pear-wrk-wdk'))).toBe(false)
  })

  it('pulls bare-walk-handles and the diagnostic into the bundle when handleLeakCheck is enabled', async () => {
    const code = generateHandleLeakCheckCode(createMockConfig({ options: { handleLeakCheck: true } }))
    expect(code).toContain('registerHandleLeakCheck')

    const files = await pack('entry-on.js', code, 'on')

    expect(files.some(f => f.includes('bare-walk-handles'))).toBe(true)
    expect(files.some(f => f.endsWith('diagnostics/handle-leak-check.js'))).toBe(true)
  })
})
