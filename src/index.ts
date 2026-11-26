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
export { generateBundle, generateSourceFiles, stowBundle } from './bundler'
export type { GenerateBundleOptions, GenerateBundleResult, StowBundleOptions, StowBundleResult, StowLanguage, BareRpcLimits, EsmToCjsStats } from './bundler'

// Generators
export { generateEntryPoint } from './generators/entry'
export { generateWalletModulesCode } from './generators/wallet-modules'
