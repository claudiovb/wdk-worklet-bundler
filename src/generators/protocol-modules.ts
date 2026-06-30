/**
 * Protocol modules code generator
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
 * Generate protocol modules code section
 */
export function generateProtocolModulesCode (config: ResolvedConfig): string {
  if (config.protocols == null) {
    return '// No protocols configured'
  }

  const lines: string[] = []

  lines.push('// Load protocol modules')

  const packages = new Map<string, string>()

  for (const protocolConfig of Object.values(config.protocols)) {
    const pkg = protocolConfig.package
    if (!packages.has(pkg)) {
      packages.set(pkg, toVarName(pkg))
    }
  }

  for (const [pkgPath, varName] of packages) {
    lines.push(`const ${varName}Raw = require('${pkgPath}', { with: { imports: 'bare-node-runtime/imports' } });`)
    lines.push(`const ${varName} = ${varName}Raw.default || ${varName}Raw;`)
  }
  lines.push('')

  lines.push('// Map protocols to protocol managers')
  lines.push('const protocolManagers = {};')

  for (const [protocolName, protocolConfig] of Object.entries(config.protocols)) {
    const pkg = protocolConfig.package
    const varName = packages.get(pkg)
    lines.push(`protocolManagers['${protocolName}'] = ${varName};`)
  }

  return lines.join('\n')
}
