/**
 * @tetherto/wdk-worklet-bundler
 *
 * CLI tool for generating WDK worklet bundles from configuration.
 */

// Config
export { loadConfig } from './config/loader'
export type { WdkBundleConfig, ResolvedConfig } from './config/types'

// Validators
export { validateDependencies, installDependencies, uninstallDependencies, detectPackageManager, generateInstallCommand, generateUninstallCommand } from './validators/dependencies'
export type { ModuleInfo, ValidationResult, InstallResult, UninstallResult } from './validators/dependencies'

// Bundler
export { generateBundle, generateSourceFiles, linkAddons } from './bundler'
export type { GenerateBundleOptions, GenerateBundleResult, LinkAddonsOptions, LinkAddonsResult } from './bundler'
export { discoverLinkedAddons } from './bundler/linked-addons'
export type { LinkedAddon } from './bundler/linked-addons'
export { readBundle, writeBundleFile, wrapperForPath } from './bundler/bundle-file'
export type { BundleWrapper } from './bundler/bundle-file'
export { packBundle, MissingModuleError } from './bundler/pack'
export type { PackBundleOptions, PackBundleResult, EsmToCjsStats, ConditionalSpecifier } from './bundler/pack'

// Generators
export { generateEntryPoint } from './generators/entry'
export { generateJsonRpcEntryPoint } from './generators/entry-jsonrpc'
export { generateAddonsYml } from './generators/addons-yml'
export { generateWalletModulesCode } from './generators/wallet-modules'
