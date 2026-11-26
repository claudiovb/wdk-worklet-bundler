/**
 * Configuration loader
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import type { WdkBundleConfig, ResolvedConfig } from './types'
import { validateConfig } from './schema'
import { DEFAULT_PACKAGE_PATH } from '../constants'

const CONFIG_FILES = [
  'wdk.config.js',
  'wdk.config.cjs',
  'wdk.config.mjs'
]

/**
 * Find config file in directory
 */
function findConfigFile (dir: string): string | null {
  for (const filename of CONFIG_FILES) {
    const filepath = path.join(dir, filename)
    if (fs.existsSync(filepath)) {
      return filepath
    }
  }
  return null
}

async function loadConfigFile (filepath: string): Promise<WdkBundleConfig> {
  const ext = path.extname(filepath)

  if (ext === '.json' || filepath.endsWith('.wdkrc')) {
    const content = fs.readFileSync(filepath, 'utf-8')
    try {
      return JSON.parse(content) as WdkBundleConfig
    } catch (error) {
      throw new Error(
        `Invalid JSON in config file ${filepath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  // For JS/MJS/CJS files, use dynamic import (supports both CommonJS and ESM)
  const loaded = await import(pathToFileURL(filepath).href) as { default?: WdkBundleConfig } & WdkBundleConfig

  // Handle ES module default exports
  return loaded.default ?? loaded
}

/**
 * Whether the bundle gets the post-pack ESM→CJS conversion.
 *
 * Single source of truth shared by the bundler step and the entry
 * generators, so the runtime `.mjs` loader patch emitted into the entry
 * always matches what was actually done to the bundle.
 *
 * Independent of transport and platform. The default follows the engine: off
 * for V8, which loads ESM, and on for the engines whose Bare port can't (JSC,
 * QuickJS).
 */
export function shouldConvertEsmToCjs (config: WdkBundleConfig): boolean {
  return config.options?.convertEsmToCjs ?? (config.options?.engine ?? 'v8') !== 'v8'
}

/** Values given on the command line that replace the config file's. */
export type ConfigOverrides = Partial<Pick<WdkBundleConfig, 'transport'>> & {
  /**
   * Folder with the package.json and node_modules the worklet is built from,
   * relative to the current directory. Defaults to the folder of the config file.
   */
  projectRoot?: string
}

/**
 * Load, validate and resolve the config file.
 *
 * @param configPath - Path of the config file. Defaults to the wdk.config.*
 *   file of the current directory.
 * @param overrides - Values that replace the config file's before validation.
 * @throws {Error} If the file is missing, is not valid JSON, or the config,
 *   with the overrides applied, is invalid.
 * @throws {Error} If the project root given in the overrides does not exist.
 */
export async function loadConfig (configPath?: string, overrides: ConfigOverrides = {}): Promise<ResolvedConfig> {
  const cwd = process.cwd()

  // Find config file
  let filepath: string

  if (configPath) {
    filepath = path.resolve(cwd, configPath)
    if (!fs.existsSync(filepath)) {
      throw new Error(`Config file not found: ${filepath}`)
    }
  } else {
    const found = findConfigFile(cwd)
    if (!found) {
      throw new Error(
        'No wdk.config.js found. Run `npx wdk-worklet-bundler init` to create one.\n' +
          `Searched for: ${CONFIG_FILES.join(', ')}`
      )
    }
    filepath = found
  }

  // Load config
  const config: WdkBundleConfig = {
    ...await loadConfigFile(filepath),
    ...(overrides.transport !== undefined ? { transport: overrides.transport } : {})
  }

  // Validate config
  validateConfig(config)

  const projectRoot = overrides.projectRoot !== undefined
    ? path.resolve(cwd, overrides.projectRoot)
    : path.dirname(filepath)

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root not found: ${projectRoot}`)
  }

  return {
    ...config,
    configPath: filepath,
    projectRoot,
    outputDir: path.resolve(path.dirname(filepath), config.output ?? DEFAULT_PACKAGE_PATH)
  }
}

export { validateConfig } from './schema'
