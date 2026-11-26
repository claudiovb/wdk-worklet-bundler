import fs from 'fs'
import path from 'path'
import Bundle from 'bare-bundle'

/** Write a file of a fixture project, creating its folders. */
export function writeFixtureFile (projDir: string, file: string, source: string): void {
  const filePath = path.join(projDir, file)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source)
}

/**
 * Give a fixture project the two packages every stowed bundle needs, as
 * stand-ins that need no install:
 *
 * - bare-stow-runtime, which bare-stow's shim requires;
 * - @tetherto/pear-wrk-wdk, whose `createServerProvider` returns a provider
 *   that generates a server module recording the arguments it was created
 *   with, so a test can read them back from the bundle.
 *
 * bare-stow itself, and everything it packs and writes, is the real one.
 */
export function writeStandInPackages (projDir: string): void {
  writeFixtureFile(projDir, 'node_modules/bare-stow-runtime/package.json',
    JSON.stringify({ name: 'bare-stow-runtime', version: '0.0.0', main: 'index.js' }))
  writeFixtureFile(projDir, 'node_modules/bare-stow-runtime/index.js',
    'exports.attach = () => ({ run () {} })\n')
  writeFixtureFile(projDir, 'node_modules/bare-stow-runtime/process.js',
    "module.exports = require('.')\n")

  writeFixtureFile(projDir, 'node_modules/@tetherto/pear-wrk-wdk/package.json',
    JSON.stringify({ name: '@tetherto/pear-wrk-wdk', version: '0.0.0', main: 'index.js' }))
  writeFixtureFile(projDir, 'node_modules/@tetherto/pear-wrk-wdk/index.js',
    'exports.createServerProvider = (...args) => ({\n' +
    "  name: 'stand-in',\n" +
    '  languages: {\n' +
    "    javascript: { generate: () => ({ source: 'exports.attach = () => null\\nexports.createdWith = ' + JSON.stringify(args) + '\\n' }) }\n" +
    '  }\n' +
    '})\n')
}

/** The source bare-stow packs as the server module for the stand-in provider. */
export function standInServerSource (...createdWith: unknown[]): string {
  return `exports.attach = () => null\nexports.createdWith = ${JSON.stringify(createdWith)}\n`
}

/** Parse the bundle a stowed package holds. */
export function readStowedBundle (bundlePath: string): Bundle {
  return Bundle.from(fs.readFileSync(bundlePath) as unknown as Parameters<typeof Bundle.from>[0])
}

/** The source of one file of a bundle. */
export function readBundleFile (bundle: Bundle, key: string): string {
  return (bundle.read(key) as unknown as Buffer).toString()
}
