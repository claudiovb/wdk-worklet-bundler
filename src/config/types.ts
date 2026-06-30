/**
 * Configuration types for wdk-worklet-bundler
 */

export interface WdkBundleConfig {
  /** Module definitions: key -> package path */
  networks: {
    [networkName: string]: {
      package: string
    }
  }

  /** Protocol definitions: key -> package path */
  protocols?: {
    [protocolName: string]: {
      package: string
      [key: string]: unknown
    }
  }

  /** Modules to preload (native addons like spark-frost-bare-addon) */
  preloadModules?: string[]

  /** Output paths */
  output?: {
    bundle?: string
    types?: string
  }

  /** Build options */
  options?: {
    minify?: boolean
    sourceMaps?: boolean
    targets?: string[]
  }
}

export interface ResolvedConfig extends WdkBundleConfig {
  /** Absolute path to config file */
  configPath: string
  /** Absolute path to project root */
  projectRoot: string
  /** Resolved output paths (absolute) */
  resolvedOutput: {
    bundle: string
    types: string
  }
}
