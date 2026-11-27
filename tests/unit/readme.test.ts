import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { configSchema, validateConfig } from '../../src/config/schema'

describe('README configuration reference', () => {
  const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8')

  it('lists every build option of the config schema', () => {
    const buildOptions = readme.match(
      /  \/\/ ── Build options ─+\n  options: \{\n([\s\S]*?)\n  \},\n};/
    )

    expect(buildOptions).not.toBeNull()

    const listed = [...(buildOptions?.[1] ?? '').matchAll(/^ {4}(\w+):/gm)].map((match) => match[1])

    expect(listed.sort()).toEqual(Object.keys(configSchema.properties.options.properties).sort())
  })

  it('lists every top-level key of the config schema', () => {
    const reference = readme.match(/```javascript\nmodule\.exports = \{\n  \/\/ ── Transport[\s\S]*?\n\};\n```/)

    expect(reference).not.toBeNull()

    const listed = [...(reference?.[0] ?? '').matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])

    expect(listed.sort()).toEqual(Object.keys(configSchema.properties).sort())
  })

  it('shows configs that the schema accepts', () => {
    const configs = [...readme.matchAll(/^( *)```javascript\n([\s\S]*?module\.exports = \{[\s\S]*?\n\1\};)\n\1```/gm)].map((match) => {
      const sandbox = { module: { exports: {} } }
      vm.runInNewContext(match[2], sandbox)
      return sandbox.module.exports
    })

    expect(configs).toHaveLength(2)
    for (const config of configs) {
      expect(() => validateConfig(config)).not.toThrow()
    }
  })
})
