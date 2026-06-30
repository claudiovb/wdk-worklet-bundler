/**
 * Native addons linker
 * Uses bare-link to generate platform-specific native addon files
 */

import fs from 'fs'
import path from 'path'
import type { ResolvedConfig } from '../config/types'
import { getModulesForPlatform, BARE_LINK_HOSTS, DEFAULT_SWIFT_TARGET } from '../constants'
import { generateAddonsYml } from '../generators/addons-yml'

export interface LinkAddonsOptions {
  platforms?: Array<'ios' | 'macos' | 'android'>
  verbose?: boolean
  silent?: boolean
}

export interface LinkAddonsResult {
  success: boolean
  duration: number
  platforms: string[]
  error?: string
}

/**
 * Link native bare modules for each target platform using bare-link.
 * Generates addon files that consumers need to embed in their native projects.
 */
export async function linkAddons (
  config: ResolvedConfig,
  options: LinkAddonsOptions = {}
): Promise<LinkAddonsResult> {
  const startTime = Date.now()
  const { verbose, silent } = options
  const log = (msg: string): void => { if (!silent) console.log(msg) }

  const platforms = options.platforms ?? config.options?.platforms ?? ['ios', 'macos', 'android']

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const link = require('bare-link') as (modulePath: string, opts: { hosts: string[], out: string }) => AsyncIterable<unknown>

    for (const platform of platforms) {
      const outputPath = config.resolvedOutput.addons[platform]
      const hosts = BARE_LINK_HOSTS[platform]

      log(`  Linking addons for ${platform} → ${outputPath}`)
      fs.mkdirSync(outputPath, { recursive: true })

      const modules = getModulesForPlatform(platform)
      for (const moduleName of modules) {
        const modulePath = path.join(config.projectRoot, 'node_modules', moduleName)

        if (!fs.existsSync(modulePath)) {
          if (verbose) log(`    Skipping ${moduleName} (not installed)`)
          continue
        }

        if (verbose) log(`    Linking ${moduleName}...`)

        // bare-link is an async generator — iterate to completion
        for await (const step of link(modulePath, { hosts, out: outputPath })) { void step }
      }

      log(`  ✓ ${platform} addons → ${outputPath}`)

      // Generate addons.yml after iOS linking
      if (platform === 'ios') {
        const swiftTarget = config.options?.swiftTarget ?? DEFAULT_SWIFT_TARGET
        generateAddonsYml(outputPath, swiftTarget, config.resolvedOutput.addonsYml)
        log(`  ✓ addons.yml → ${config.resolvedOutput.addonsYml}`)
      }
    }

    return { success: true, duration: Date.now() - startTime, platforms }
  } catch (error) {
    return {
      success: false,
      duration: Date.now() - startTime,
      platforms,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
