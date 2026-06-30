import fs from 'fs'
import path from 'path'

/**
 * Generate addons.yml for BareKit Swift integration.
 * Reads the xcframework files produced by bare-link and emits
 * the YAML dependency list that Xcode / BareKit expects.
 */
export function generateAddonsYml (
  iosAddonsDir: string,
  swiftTarget: string,
  outputPath: string
): void {
  if (!fs.existsSync(iosAddonsDir)) return

  const frameworks = fs.readdirSync(iosAddonsDir)
    .filter((f) => f.endsWith('.xcframework'))
    .sort()

  if (frameworks.length === 0) return

  const deps = frameworks.map((f) => `      - framework: ${f}`).join('\n')

  const yaml = `targets:\n  ${swiftTarget}:\n    dependencies:\n${deps}\n`

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, yaml, 'utf-8')
}
