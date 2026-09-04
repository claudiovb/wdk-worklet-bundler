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
 *   Apple    linked:<name>.<version>.framework/<name>.<version>   (or unversioned <name>.framework/<name>)
 *   Android  linked:lib<name>.<version>.so                        (Linux identical; darwin dylib variant lib<name>.<version>.dylib)
 *   Windows  linked:<name>-<version>.dll
 *
 * The header is usage-derived ground truth: it lists exactly the addons the
 * packed code will ask for, no more and no fewer. bare-pack also packs the
 * package.json of every traversed package, so the directory of each addon
 * package is read from the bundle as well — no filesystem guessing, nested
 * duplicates included.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import type Bundle from 'bare-bundle'

/** A native addon package the bundle will load at runtime. */
export interface LinkedAddon {
  /** npm package name, e.g. `bare-fs` or `@scope/native`. */
  name: string
  /** Package version, from the package.json bare-pack packed alongside the addon. */
  version: string
  /** Absolute path of the package directory to hand to bare-link. */
  dir: string
  /**
   * Artefact basenames the header promises for this package, one per host
   * platform packed, e.g. `['libbare-fs.4.7.4.so', 'bare-fs.4.7.4.framework']`.
   */
  artefacts: string[]
}

const LINKED_PROTOCOL = 'linked:'

/** Semver core with optional prerelease and build metadata. */
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'

/**
 * One pattern per artefact shape produced by bare-addon-resolve. The name
 * group is lazy so a dotted package name still splits correctly from the
 * version (`foo.bar.1.0.0.framework` → name `foo.bar`, version `1.0.0`).
 */
const ARTEFACT_PATTERNS: RegExp[] = [
  new RegExp(`^(?<name>.+?)(?:\\.(?<version>${SEMVER}))?\\.framework/`),
  new RegExp(`^lib(?<name>.+?)(?:\\.(?<version>${SEMVER}))?\\.(?:so|dylib)$`),
  new RegExp(`^(?<name>.+?)(?:-(?<version>${SEMVER}))?\\.dll$`)
]

/** Artefact file extension bare-link produces for each platform we link. */
const PLATFORM_ARTEFACT_EXTENSION: Record<string, string> = {
  ios: '.framework',
  macos: '.framework',
  android: '.so'
}

interface PackedAddonPackage { name: string, version: string, dir: string }

/**
 * Discover the native addons a packed bundle will load at runtime.
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
    const artefact = parseLinkedHref(href)
    const name = demangleAddonName(artefact.name)
    const pkg = packages.find(p => p.name === name && (artefact.version === null || p.version === artefact.version))
    if (pkg === undefined) {
      throw new Error(`Bundle header lists addon '${href}' but contains no package.json for ${name}${artefact.version === null ? '' : `@${artefact.version}`}`)
    }

    const id = `${pkg.name}@${pkg.version}`
    const entry = byPackage.get(id) ?? { name: pkg.name, version: pkg.version, dir: pkg.dir, artefacts: [] }
    entry.artefacts.push(artefact.basename)
    byPackage.set(id, entry)
  }

  return [...byPackage.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Select the addons that bare-link did not produce an artefact for on the
 * given platform, given the basenames of every resource bare-link wrote.
 * iOS and macOS frameworks share the `<name>.<version>.framework` basename,
 * so an iOS pack also checks macOS output. Addons whose header promises
 * carry no artefact for the platform family (e.g. iOS for an Android-only
 * pack) cannot be checked and are never reported.
 */
export function findMissingArtefacts (addons: LinkedAddon[], platform: string, written: ReadonlySet<string>): LinkedAddon[] {
  const extension = PLATFORM_ARTEFACT_EXTENSION[platform]
  return addons.filter(addon => {
    const expected = addon.artefacts.filter(a => a.endsWith(extension))
    return expected.length > 0 && !expected.some(a => written.has(a))
  })
}

function parseLinkedHref (href: string): { name: string, version: string | null, basename: string } {
  const artefact = href.slice(LINKED_PROTOCOL.length)
  for (const pattern of ARTEFACT_PATTERNS) {
    const match = pattern.exec(artefact)
    if (match?.groups !== undefined) {
      return {
        name: match.groups.name,
        version: match.groups.version ?? null,
        // First path segment: the .framework directory on Apple, the file itself elsewhere.
        basename: artefact.split('/')[0]
      }
    }
  }
  throw new Error(`Unrecognised linked addon artefact '${href}'`)
}

/** Reverse bare-addon-resolve's mangling; it rejects names containing `__`, so this is unambiguous. */
function demangleAddonName (mangled: string): string {
  return mangled.includes('__') ? `@${mangled.replace('__', '/')}` : mangled
}

function collectPackedAddonPackages (bundle: Bundle, projectRoot: string): PackedAddonPackage[] {
  const packages: PackedAddonPackage[] = []
  for (const key of bundle.keys()) {
    if (!key.endsWith('/package.json')) continue
    const pkg = JSON.parse(bundle.read(key).toString()) as { name?: unknown, version?: unknown, addon?: unknown }
    if (pkg.addon !== true || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
    packages.push({ name: pkg.name, version: pkg.version, dir: path.dirname(keyToPath(key, projectRoot)) })
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
