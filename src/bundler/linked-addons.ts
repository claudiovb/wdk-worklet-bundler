/**
 * Native addon discovery from a bare-pack bundle header.
 *
 * bare-pack (run with `--linked`) resolves every `require.addon()` call in
 * the module graph to a `linked:<artefact>` URL and records the full set in
 * the bundle header (`Bundle.addons`). The URL is a promise: the host app
 * will ship a native artefact with exactly that name and Bare's runtime will
 * find it through the OS loader. bare-link is the tool that produces those
 * artefacts, from the same package.json and with the same
 * `@scope/pkg` → `scope__pkg` name mangling (see bare-addon-resolve and
 * bare-link's dependencies.js).
 *
 * Artefact names are platform-shaped:
 *   Apple    linked:<name>.<version>.framework/<name>.<version>   (or unversioned <name>.framework/<name>; macOS may also promise lib<name>.<version>.dylib)
 *   Android  linked:lib<name>.<version>.so                        (Linux identical)
 *   Windows  linked:<name>-<version>.dll
 *
 * The header is usage-derived ground truth: it lists exactly the addons the
 * packed code will ask for, no more and no fewer. bare-pack also packs the
 * package.json of every traversed package, so the directory of each addon
 * package is read from the bundle as well — no filesystem guessing, nested
 * duplicates included.
 *
 * Which platforms to link for is derived from the hosts the bundle was packed
 * for (`options.targets`): the OS prefix of a host triple names the platform
 * whose artefacts the header promises, for every platform bare-link supports.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import type Bundle from 'bare-bundle'

/** Family of a native artefact, determined by the shape of its `linked:` name. */
export type ArtefactFamily = 'apple' | 'elf' | 'windows'

/** A native artefact the header promises. */
export interface LinkedArtefact {
  /** Basename bare-link writes: the `.framework` directory on Apple, the file itself elsewhere. */
  name: string
  family: ArtefactFamily
}

/** A native addon package the bundle will load at runtime. */
export interface LinkedAddon {
  /** npm package name, e.g. `bare-fs` or `@scope/native`. */
  name: string
  /** Package version, from the package.json bare-pack packed alongside the addon. */
  version: string
  /** Absolute path of the package directory to hand to bare-link. */
  dir: string
  /** Artefacts the header promises for this package, one per host platform packed. */
  artefacts: LinkedArtefact[]
}

/** A platform the bundler links addons for. */
export type LinkPlatform = 'ios' | 'macos' | 'android' | 'linux' | 'windows'

const LINKED_PROTOCOL = 'linked:'

/** Semver core with optional prerelease and build metadata. */
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'

/**
 * One pattern per artefact shape produced by bare-addon-resolve. The name
 * group is lazy so a dotted package name still splits correctly from the
 * version (`foo.bar.1.0.0.framework` → name `foo.bar`, version `1.0.0`).
 */
const ARTEFACT_PATTERNS: Array<{ family: ArtefactFamily, pattern: RegExp }> = [
  { family: 'apple', pattern: new RegExp(`^(?<name>.+?)(?:\\.(?<version>${SEMVER}))?\\.framework/`) },
  { family: 'apple', pattern: new RegExp(`^lib(?<name>.+?)(?:\\.(?<version>${SEMVER}))?\\.dylib$`) },
  { family: 'elf', pattern: new RegExp(`^lib(?<name>.+?)(?:\\.(?<version>${SEMVER}))?\\.so$`) },
  { family: 'windows', pattern: new RegExp(`^(?<name>.+?)(?:-(?<version>${SEMVER}))?\\.dll$`) }
]

/**
 * Platforms the bundler can link for, keyed by the OS prefix of a bare host
 * triple (`ios-arm64` → `ios`), with the artefact family the header promises
 * for them. Order is the order platforms are linked in.
 */
const LINK_PLATFORMS: Array<{ platform: LinkPlatform, hostPrefix: string, family: ArtefactFamily }> = [
  { platform: 'ios', hostPrefix: 'ios', family: 'apple' },
  { platform: 'macos', hostPrefix: 'darwin', family: 'apple' },
  { platform: 'android', hostPrefix: 'android', family: 'elf' },
  { platform: 'linux', hostPrefix: 'linux', family: 'elf' },
  { platform: 'windows', hostPrefix: 'win32', family: 'windows' }
]

interface PackedAddonPackage { name: string, mangledName: string, version: string, dir: string }

/**
 * Derive the platforms to link addons for from the hosts a bundle is packed
 * for, in link order and without duplicates.
 *
 * @param hosts - bare host triples, e.g. `['ios-arm64', 'android-arm64']`.
 * @returns The platforms whose artefacts the header can promise.
 * @throws {Error} If a host's OS prefix is not one bare-link supports
 *   (`ios-*`, `darwin-*`, `android-*`, `linux-*`, `win32-*`).
 */
export function linkPlatformsForHosts (hosts: string[]): LinkPlatform[] {
  const unsupported = hosts.filter(host => !LINK_PLATFORMS.some(p => hostPrefixOf(host) === p.hostPrefix))
  if (unsupported.length > 0) {
    throw new Error(
      `Cannot link native addons for hosts ${unsupported.join(', ')}: ` +
      `supported host families are ${LINK_PLATFORMS.map(p => `${p.hostPrefix}-*`).join(', ')}`
    )
  }
  return LINK_PLATFORMS
    .filter(p => hosts.some(host => hostPrefixOf(host) === p.hostPrefix))
    .map(p => p.platform)
}

/** The subset of `hosts` that belong to `platform`, in their original order. */
export function hostsForPlatform (platform: LinkPlatform, hosts: string[]): string[] {
  const { hostPrefix } = LINK_PLATFORMS.find(p => p.platform === platform)!
  return hosts.filter(host => hostPrefixOf(host) === hostPrefix)
}

/**
 * Discover the native addons a packed bundle will load at runtime and the
 * host app must ship. Only `linked:` hrefs count: an addon the pack resolved
 * to a `builtin:` URL (listed in `options.builtins`) is embedded in the host
 * runtime and is skipped here.
 *
 * @param bundle - A bundle produced by bare-pack with `--linked`.
 * @param projectRoot - Directory bare-pack ran in; bundle keys are relative to it.
 * @returns One entry per addon package, sorted by name.
 * @throws {Error} If the header lists a `linked:` URL whose shape is not one
 *   bare-addon-resolve produces, or whose package.json is not in the bundle —
 *   both mean the bundle was not produced by the bare-pack invocation this
 *   package performs.
 */
export function discoverLinkedAddons (bundle: Bundle, projectRoot: string): LinkedAddon[] {
  const packages = collectPackedAddonPackages(bundle, projectRoot)
  const byPackage = new Map<string, LinkedAddon>()

  for (const href of bundle.addons) {
    if (!href.startsWith(LINKED_PROTOCOL)) continue
    const artefact = parseLinkedHref(href)
    const pkg = packages.find(p => p.mangledName === artefact.mangledName && (artefact.version === null || p.version === artefact.version))
    if (pkg === undefined) {
      throw new Error(`Bundle header lists addon '${href}' but contains no package.json for ${artefact.mangledName}${artefact.version === null ? '' : `@${artefact.version}`}`)
    }

    const id = `${pkg.name}@${pkg.version}`
    const entry = byPackage.get(id) ?? { name: pkg.name, version: pkg.version, dir: pkg.dir, artefacts: [] }
    entry.artefacts.push({ name: artefact.name, family: artefact.family })
    byPackage.set(id, entry)
  }

  return [...byPackage.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Select the addons that bare-link did not produce an artefact for on the
 * given platform, given the basenames of every resource bare-link wrote.
 * An artefact counts for a platform when its family matches (iOS and macOS
 * are both Apple, so an iOS pack also checks macOS output). Addons with no
 * promise in the platform's family cannot be checked and are never reported.
 */
export function findMissingArtefacts (addons: LinkedAddon[], platform: LinkPlatform, written: ReadonlySet<string>): LinkedAddon[] {
  const { family } = LINK_PLATFORMS.find(p => p.platform === platform)!
  return addons.filter(addon => {
    const expected = addon.artefacts.filter(a => a.family === family)
    return expected.length > 0 && !expected.some(a => written.has(a.name))
  })
}

function hostPrefixOf (host: string): string {
  return host.split('-', 1)[0]
}

function parseLinkedHref (href: string): { mangledName: string, version: string | null, name: string, family: ArtefactFamily } {
  const artefact = href.slice(LINKED_PROTOCOL.length)
  for (const { family, pattern } of ARTEFACT_PATTERNS) {
    const match = pattern.exec(artefact)
    if (match?.groups !== undefined) {
      return {
        mangledName: match.groups.name,
        version: match.groups.version ?? null,
        // First path segment: the .framework directory on Apple, the file itself elsewhere.
        name: artefact.split('/')[0],
        family
      }
    }
  }
  throw new Error(`Unrecognised linked addon artefact '${href}'`)
}

/**
 * The exact mangling bare-addon-resolve and bare-link apply to a package
 * name before using it in an artefact name (`@scope/pkg` → `scope__pkg`),
 * mirrored so the comparison is mangled-to-mangled in one direction.
 */
function mangleAddonName (name: string): string {
  return name.replace(/\//g, '__').replace(/^@/, '')
}

function collectPackedAddonPackages (bundle: Bundle, projectRoot: string): PackedAddonPackage[] {
  const packages: PackedAddonPackage[] = []
  for (const key of bundle.keys()) {
    if (!key.endsWith('/package.json')) continue
    const pkg = JSON.parse(bundle.read(key).toString()) as { name?: unknown, version?: unknown, addon?: unknown }
    if (pkg.addon !== true || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
    packages.push({ name: pkg.name, mangledName: mangleAddonName(pkg.name), version: pkg.version, dir: path.dirname(keyToPath(key, projectRoot)) })
  }
  return packages
}

/**
 * bare-pack unmounts the bundle against its base (our project root), so keys
 * under it are root-relative; files outside the base (e.g. a hoisted
 * workspace node_modules) keep their absolute file: URL.
 */
function keyToPath (key: string, projectRoot: string): string {
  return key.startsWith('file:') ? fileURLToPath(key) : path.join(projectRoot, key)
}
