import fs from 'fs'
import path from 'path'

export interface ModuleInfo {
  name: string
  path: string
  version: string
  isLocal: boolean
}

export interface ValidationResult {
  valid: boolean
  installed: ModuleInfo[]
  missing: string[]
}

export function resolveModule (
  modulePath: string,
  projectRoot: string
): ModuleInfo | null {
  if (modulePath.startsWith('.') || modulePath.startsWith('/')) {
    const absolutePath = path.resolve(projectRoot, modulePath)
    if (fs.existsSync(absolutePath)) {
      const pkgPath = path.join(absolutePath, 'package.json')
      let pkg = { name: path.basename(absolutePath), version: 'local' }

      if (fs.existsSync(pkgPath)) {
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        } catch {
          // Use default if package.json is malformed
        }
      }

      return {
        name: pkg.name,
        path: absolutePath,
        version: pkg.version,
        isLocal: true
      }
    }
    return null
  }

  const nodeModulesPath = path.join(projectRoot, 'node_modules', modulePath)

  if (!fs.existsSync(nodeModulesPath)) {
    return null
  }

  const pkgPath = path.join(nodeModulesPath, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return null
  }

  let pkg: { name: string, version: string }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  } catch {
    return null
  }

  return {
    name: pkg.name,
    path: nodeModulesPath,
    version: pkg.version,
    isLocal: false
  }
}

export function validateDependencies (
  modules: string[],
  projectRoot: string
): ValidationResult {
  const installed: ModuleInfo[] = []
  const missing: string[] = []

  for (const modulePath of modules) {
    const info = resolveModule(modulePath, projectRoot)

    if (info != null) {
      installed.push(info)
    } else {
      missing.push(modulePath)
    }
  }

  return {
    valid: missing.length === 0,
    installed,
    missing
  }
}

export interface MissingPeer {
  name: string
  sources: Array<{
    parent: string
    range: string
  }>
}

export function checkOptionalPeerDependencies (
  installedModules: ModuleInfo[],
  projectRoot: string,
  options: { verbose?: boolean } = {}
): MissingPeer[] {
  const missingPeers = new Map<string, MissingPeer>()
  const visitedPaths = new Set<string>()
  const queue: Array<{ path: string, name: string }> = installedModules.map(m => ({ path: m.path, name: m.name }))

  const log = (msg: string) => {
    if (options.verbose) console.log(msg)
  }

  const IGNORED_PREFIXES = [
    'react',
    '@react-native',
    'expo',
    '@expo',
    '@types',
    'typescript',
    'jest',
    'eslint',
    'prettier',
    'metro',
    'babel',
    'webpack',
    'ts-node',
    'bare',
    'b4a',
    'sodium-javascript'
  ]

  while (queue.length > 0) {
    const { path: currentPath, name: currentName } = queue.shift()!

    if (visitedPaths.has(currentPath)) continue
    visitedPaths.add(currentPath)

    log(`[scan] Visiting: ${currentName}`)

    const pkgPath = path.join(currentPath, 'package.json')
    if (!fs.existsSync(pkgPath)) continue

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

      const peerDeps: Record<string, string> = pkg.peerDependencies || {}
      for (const [peerName, range] of Object.entries(peerDeps)) {
        if (IGNORED_PREFIXES.some(prefix => peerName.startsWith(prefix)) || peerName === 'react-native') {
          log(`  [scan] Skipping ignored peer: ${peerName}`)
          continue
        }

        // Check if installed in project root (peer deps should be hoisted)
        const peerInfo = resolveModule(peerName, projectRoot)

        if (peerInfo == null) {
          log(`  [scan] Missing peer: ${peerName} (required by ${currentName})`)

          if (!missingPeers.has(peerName)) {
            missingPeers.set(peerName, {
              name: peerName,
              sources: []
            })
          }

          missingPeers.get(peerName)!.sources.push({
            parent: currentName,
            range
          })
        } else {
          // If installed, recurse into it
          log(`  [scan] Found peer: ${peerName}`)
          queue.push({ path: peerInfo.path, name: peerInfo.name })
        }
      }

      const deps = pkg.dependencies || {}
      for (const depName of Object.keys(deps)) {
        if (IGNORED_PREFIXES.some(prefix => depName.startsWith(prefix)) || depName === 'react-native') {
          log(`  [scan] Skipping ignored dep: ${depName}`)
          continue
        }

        let depInfo = resolveModule(depName, projectRoot)

        if (depInfo == null) {
          const nestedPath = path.join(currentPath, 'node_modules', depName)
          if (fs.existsSync(nestedPath)) {
            depInfo = {
              name: depName,
              path: nestedPath,
              version: 'unknown',
              isLocal: false
            }
          }
        }

        if (depInfo != null) {
          log(`  [scan] Recursing into dep: ${depName}`)
          queue.push({ path: depInfo.path, name: depInfo.name })
        } else {
          log(`  [scan] Could not resolve dep: ${depName}`)
        }
      }
    } catch {
    }
  }

  return Array.from(missingPeers.values())
}

export function detectPackageManager (
  projectRoot: string
): 'npm' | 'yarn' | 'pnpm' {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
    return 'yarn'
  }
  return 'npm'
}

export function generateInstallCommand (
  missing: string[],
  packageManager: 'npm' | 'yarn' | 'pnpm' = 'npm'
): string {
  const packages = missing.filter(
    (m) => !m.startsWith('.') && !m.startsWith('/')
  )

  if (packages.length === 0) {
    return ''
  }

  switch (packageManager) {
    case 'yarn':
      return `yarn add ${packages.join(' ')}`
    case 'pnpm':
      return `pnpm add ${packages.join(' ')}`
    default:
      return `npm install ${packages.join(' ')}`
  }
}

export interface InstallResult {
  success: boolean
  command: string
  installed: string[]
  failed: string[]
  error?: string
}

export interface UninstallResult {
  success: boolean
  command: string
  removed: string[]
  failed: string[]
  error?: string
}

export function installDependencies (
  missing: string[],
  projectRoot: string,
  options: { verbose?: boolean } = {}
): InstallResult {
  const { execFileSync } = require('child_process')

  const packages = missing.filter(
    (m) => !m.startsWith('.') && !m.startsWith('/')
  )

  const localPaths = missing.filter(
    (m) => m.startsWith('.') || m.startsWith('/')
  )

  if (packages.length === 0) {
    return {
      success: localPaths.length === 0,
      command: '',
      installed: [],
      failed: localPaths,
      error: localPaths.length > 0
        ? `Cannot auto-install local paths: ${localPaths.join(', ')}`
        : undefined
    }
  }

  const packageManager = detectPackageManager(projectRoot)
  const command = generateInstallCommand(packages, packageManager)
  const subcmd = packageManager === 'npm' ? 'install' : 'add'

  try {
    execFileSync(packageManager, [subcmd, ...packages], {
      cwd: projectRoot,
      stdio: options.verbose ? 'inherit' : 'pipe'
    })

    return {
      success: localPaths.length === 0,
      command,
      installed: packages,
      failed: localPaths,
      error: localPaths.length > 0
        ? `Cannot auto-install local paths: ${localPaths.join(', ')}`
        : undefined
    }
  } catch (error) {
    return {
      success: false,
      command,
      installed: [],
      failed: [...packages, ...localPaths],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function generateUninstallCommand (
  packages: string[],
  packageManager: 'npm' | 'yarn' | 'pnpm' = 'npm'
): string {
  // Filter out local paths
  const npmPackages = packages.filter(
    (m) => !m.startsWith('.') && !m.startsWith('/')
  )

  if (npmPackages.length === 0) {
    return ''
  }

  switch (packageManager) {
    case 'yarn':
      return `yarn remove ${npmPackages.join(' ')}`
    case 'pnpm':
      return `pnpm remove ${npmPackages.join(' ')}`
    default:
      return `npm uninstall ${npmPackages.join(' ')}`
  }
}

export function uninstallDependencies (
  packages: string[],
  projectRoot: string,
  options: { verbose?: boolean } = {}
): UninstallResult {
  const { execFileSync } = require('child_process')

  const npmPackages = packages.filter(
    (m) => !m.startsWith('.') && !m.startsWith('/')
  )

  if (npmPackages.length === 0) {
    return {
      success: true,
      command: '',
      removed: [],
      failed: []
    }
  }

  const packageManager = detectPackageManager(projectRoot)
  const command = generateUninstallCommand(npmPackages, packageManager)
  const subcmd = packageManager === 'npm' ? 'uninstall' : 'remove'

  try {
    execFileSync(packageManager, [subcmd, ...npmPackages], {
      cwd: projectRoot,
      stdio: options.verbose ? 'inherit' : 'pipe'
    })

    return {
      success: true,
      command,
      removed: npmPackages,
      failed: []
    }
  } catch (error) {
    return {
      success: false,
      command,
      removed: [],
      failed: npmPackages,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
