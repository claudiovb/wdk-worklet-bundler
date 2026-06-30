/**
 * Wallet modules code generator
 */

import type { ResolvedConfig } from '../config/types'

/**
 * Convert package name to a safe variable name fragment
 */
function toVarName (pkg: string): string {
  const clean = pkg.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9]/g, '_')
  return clean.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')
}

/**
 * Generate wallet modules code section.
 *
 * WDK core is loaded eagerly (same as pear-wrk-wdk-jsonrpc).
 * Wallet packages are loaded lazily via a Proxy — this matches the pattern
 * used in pear-wrk-wdk-jsonrpc and avoids the async ES-module evaluation
 * issue that occurs when packages with "type":"module" and bare.js entries
 * are required at bundle top-level before the runtime is fully settled.
 */
export function generateWalletModulesCode (config: ResolvedConfig): string {
  const lines: string[] = []

  if (config.preloadModules?.length) {
    lines.push('// Preload modules')
    for (const mod of config.preloadModules) {
      lines.push(`require('${mod}')`)
    }
    lines.push('')
  }

  // WDK core — eager load with error capture (same pattern as pear-wrk-wdk-jsonrpc)
  lines.push('// Load WDK core')
  lines.push('let WDK = null')
  lines.push('let wdkLoadError = null')
  lines.push('try {')
  lines.push("  const _wdkModule = require('@tetherto/wdk', { with: { imports: 'bare-node-runtime/imports' } })")
  lines.push('  WDK = _wdkModule.default || _wdkModule.WDK || _wdkModule')
  lines.push('} catch (_err) {')
  lines.push('  wdkLoadError = _err')
  lines.push("  console.error('Failed to load WDK module:', _err)")
  lines.push('}')
  lines.push('')

  // Build network → package mapping for the Proxy
  const networkPackages: Array<{ network: string, pkg: string }> = Object.entries(config.networks)
    .map(([network, cfg]) => ({ network, pkg: cfg.package }))

  // Deduplicate packages for the require() calls
  const packages = new Map<string, string>()
  for (const { pkg } of networkPackages) {
    if (!packages.has(pkg)) {
      packages.set(pkg, toVarName(pkg))
    }
  }

  // Lazy loader function
  lines.push('// Wallet modules — lazy loaded on first access (avoids top-level ES module evaluation issues)')
  lines.push('const _walletCache = {}')
  lines.push('')
  lines.push('function _loadWallet (network) {')
  lines.push("  if (_walletCache[network]) return _walletCache[network]")
  lines.push('  let _mod')
  for (const { network, pkg } of networkPackages) {
    lines.push(`  if (network === '${network}') _mod = require('${pkg}', { with: { imports: 'bare-node-runtime/imports' } })`)
  }
  lines.push('  if (_mod) _walletCache[network] = _mod.default || _mod')
  lines.push('  return _walletCache[network] || null')
  lines.push('}')
  lines.push('')

  const networkNames = networkPackages.map(({ network }) => `'${network}'`).join(', ')
  lines.push('const walletManagers = new Proxy({}, {')
  lines.push('  get: (_, network) => _loadWallet(network),')
  lines.push(`  has: (_, network) => [${networkNames}].includes(network)`)
  lines.push('})')

  return lines.join('\n')
}
