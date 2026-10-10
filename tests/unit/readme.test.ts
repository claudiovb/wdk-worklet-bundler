import fs from 'fs'
import path from 'path'

describe('README configuration reference', () => {
  it('lists every supported build option', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8')
    const buildOptions = readme.match(
      /  \/\/ ── Build options ─+\n  options: \{\n([\s\S]*?)\n  \},\n};/
    )

    expect(buildOptions).not.toBeNull()

    const supportedOptions = [
      'minify',
      'sourceMaps',
      'targets',
      'linkAddons',
      'swiftTarget',
      'convertEsmToCjs',
      'builtins',
      'handleLeakCheck'
    ]

    for (const option of supportedOptions) {
      expect(buildOptions?.[1]).toMatch(new RegExp(`\\b${option}:`))
    }
  })
})
