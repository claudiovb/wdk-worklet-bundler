/**
 * Module code generator
 */

import type { ResolvedConfig } from '../config/types'

/**
 * Capitalize first letter
 */
function capitalize (str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Convert module key to variable name
 */
function toVarName (pkg: string): string {
  // Remove scope (@scope/), split by non-alphanumeric, camelCase
  const clean = pkg.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9]/g, '_')
  return clean.split('_').map(capitalize).join('')
}

/**
 * Generate modules code section
 */
export function generateModuleModulesCode (config: ResolvedConfig): string {
  if (config.modules == null) {
    return '// No modules configured'
  }

  const lines: string[] = []
  const packages = new Map<string, string>()

  for (const moduleConfig of Object.values(config.modules)) {
    const pkg = moduleConfig.package
    if (!packages.has(pkg)) {
      packages.set(pkg, toVarName(pkg))
    }
  }

  lines.push('// Load modules')
  for (const [pkgPath, varName] of packages) {
    lines.push(`const ${varName}Raw = require('${pkgPath}', { with: { imports: 'bare-wdk-runtime/imports' }});`)
    lines.push(`const ${varName} = ${varName}Raw.default || ${varName}Raw;`)
  }
  lines.push('')

  lines.push('// Map modules to module managers (the WdkModuleManager contract)')
  lines.push('const moduleManagers = {};')

  for (const [moduleName, moduleConfig] of Object.entries(config.modules)) {
    const varName = packages.get(moduleConfig.package)
    const events = JSON.stringify(moduleConfig.events ?? [])

    // The factory is called with the full module context object and returns the
    // instance. Defaults to the package's (interop-resolved) export; an explicit
    // `factory` names a static/export to call instead.
    const callExpr = moduleConfig.factory
      ? `${varName}.${moduleConfig.factory}(ctx)`
      : `${varName}(ctx)`

    lines.push(`moduleManagers['${moduleName}'] = {`)
    lines.push(`  events: ${events},`)
    lines.push(`  createModule: (ctx) => ${callExpr}`)
    lines.push('};')
  }

  return lines.join('\n')
}
