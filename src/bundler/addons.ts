/**
 * Native addons linker
 * Uses bare-link to generate platform-specific native addon files for the
 * addons the packed bundle will load (see linked-addons.ts).
 */

import fs from 'fs'
import path from 'path'
import type { ResolvedConfig } from '../config/types'
import { BARE_LINK_HOSTS, DEFAULT_SWIFT_TARGET } from '../constants'
import { generateAddonsYml } from '../generators/addons-yml'
import { readBundle } from './bundle-file'
import { discoverLinkedAddons, findMissingArtefacts, type LinkedAddon } from './linked-addons'

export interface LinkAddonsOptions {
  platforms?: Array<'ios' | 'macos' | 'android'>
  verbose?: boolean
  silent?: boolean
}

export interface LinkAddonsResult {
  success: boolean
  duration: number
  platforms: string[]
  /** Addons discovered from the bundle header and handed to bare-link. */
  addons: LinkedAddon[]
  error?: string
}

type BareLink = (modulePath: string, opts: { hosts: string[], out: string }) => AsyncIterable<string>

/**
 * Link the native addons the packed bundle requires, for each target
 * platform, using bare-link. The addon set is read from the bundle header
 * written by `bare-pack --linked`, so the bundle must exist before linking.
 * Generates the artefacts consumers embed in their native projects.
 *
 * Fails, after linking everything it can, when bare-link produced no
 * artefact for an addon the header promises — that addon would crash the
 * worklet at runtime as soon as it is required.
 */
export async function linkAddons (
  config: ResolvedConfig,
  options: LinkAddonsOptions = {}
): Promise<LinkAddonsResult> {
  const startTime = Date.now()
  const { verbose, silent } = options
  const log = (msg: string): void => { if (!silent) console.log(msg) }

  const platforms = options.platforms ?? config.options?.platforms ?? ['ios', 'macos', 'android']
  let addons: LinkedAddon[] = []

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const link = require('bare-link') as BareLink

    addons = discoverLinkedAddons(readBundle(config.resolvedOutput.bundle), config.projectRoot)
    log(`  Discovered ${addons.length} native addons from bundle header`)
    if (verbose) for (const addon of addons) log(`    ${addon.name}@${addon.version}`)

    const gaps: string[] = []

    for (const platform of platforms) {
      const outputPath = config.resolvedOutput.addons[platform]
      const hosts = BARE_LINK_HOSTS[platform]

      log(`  Linking addons for ${platform} → ${outputPath}`)
      fs.mkdirSync(outputPath, { recursive: true })

      const written = new Set<string>()
      for (const addon of addons) {
        if (verbose) log(`    Linking ${addon.name}...`)

        // bare-link is an async generator yielding the path of each resource it writes
        for await (const resource of link(addon.dir, { hosts, out: outputPath })) {
          written.add(path.basename(resource))
        }
      }

      for (const addon of findMissingArtefacts(addons, platform, written)) {
        gaps.push(`${platform}: ${addon.name}@${addon.version} (no prebuilds for hosts ${hosts.join(', ')})`)
      }

      log(`  ✓ ${platform} addons → ${outputPath}`)

      // Generate addons.yml after iOS linking
      if (platform === 'ios') {
        const swiftTarget = config.options?.swiftTarget ?? DEFAULT_SWIFT_TARGET
        generateAddonsYml(outputPath, swiftTarget, config.resolvedOutput.addonsYml)
        log(`  ✓ addons.yml → ${config.resolvedOutput.addonsYml}`)
      }
    }

    if (gaps.length > 0) {
      return {
        success: false,
        duration: Date.now() - startTime,
        platforms,
        addons,
        error:
          'bare-link produced no artefact for addons the bundle requires; ' +
          'the worklet will fail to load them at runtime:\n' +
          gaps.map(g => `    - ${g}`).join('\n')
      }
    }

    return { success: true, duration: Date.now() - startTime, platforms, addons }
  } catch (error) {
    return {
      success: false,
      duration: Date.now() - startTime,
      platforms,
      addons,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
