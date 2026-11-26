/**
 * Configuration types for wdk-worklet-bundler
 */

export interface ProtocolAllowedMethods {
  /** Methods allowed on this protocol surface. Omit to leave unrestricted. */
  methods?: string[]
}

/** protocolName -> allowed methods, for one protocol type (e.g. all 'swap' protocols). */
export interface ProtocolNameAllowedMethods {
  [protocolName: string]: ProtocolAllowedMethods
}

/** protocolType -> ProtocolNameAllowedMethods (e.g. 'swap', 'bridge', 'lending', 'fiat'). */
export interface ProtocolTypeAllowedMethods {
  [protocolType: string]: ProtocolNameAllowedMethods
}

export interface NetworkAllowedMethods extends ProtocolAllowedMethods {
  /** Omit a level (protocols, a protocolType, or a protocolName) to leave it unrestricted. */
  protocols?: ProtocolTypeAllowedMethods
}

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

  /**
   * Generic module definitions: key -> package + optional factory/events. The
   * package exports createModule({ seed, config, capabilities, emit }) -> instance;
   * a module needing storage builds it from config (e.g. config.storagePath).
   */
  modules?: {
    [moduleName: string]: {
      /** Module package name (the factory exporting createModule(ctx)) */
      package: string
      /** Named factory export to call (default: the package's default export) */
      factory?: string
      /** Events forwarded host-ward as moduleEvent (e.g. ['update']) */
      events?: string[]
    }
  }

  /** Modules to preload (native addons like spark-frost-bare-addon) */
  preloadModules?: string[]

  /**
   * Optional but recommended: without this, callMethod can invoke any method
   * on the resolved account/protocol object, including fund-moving or
   * key-export operations. Shaped like WDK's own protocol storage:
   * https://github.com/tetherto/wdk. Only restricts the surfaces you list —
   * any level left out (a network, `protocols`, a protocolType, a
   * protocolName, or `methods` itself) stays fully unrestricted, so this is
   * opt-in one surface at a time.
   */
  allowedMethods?: {
    [network: string]: NetworkAllowedMethods
  }

  /**
   * Optional but recommended: without this, callModule can invoke any method
   * on a bundled module instance. Keyed by module name — modules aren't
   * scoped to a blockchain or protocol, so each entry is just
   * `{ methods: [...] }`. A module left out of this map (or the map being
   * unset entirely) stays unrestricted.
   */
  allowedModuleMethods?: {
    [moduleName: string]: ProtocolAllowedMethods
  }

  /** Transport the worklet serves. The host client the bundler generates is
   *  'bare-rpc' only; with 'hrpc' the generated package has no client. */
  transport: 'bare-rpc' | 'hrpc'

  /** Language of the generated host package. */
  language: 'swift' | 'kotlin'

  /** Kotlin package of the generated code, which is also the namespace of the
   *  generated module. Defaults to 'to.tether.wdk.worklet'. Not used with
   *  'swift'. */
  kotlinPackage?: string

  /** bare-stow target the bundle is packed for. Defaults to 'bare-kit'. */
  target?: 'bare-kit'

  /** Folder of the generated package (the Swift package or the Kotlin
   *  module), relative to the config file. bare-stow derives the Swift module
   *  name from its basename. Defaults to './wdk-worklet' (module WdkWorklet).
   *  On every run `generate` deletes what its last run wrote there and
   *  writes the package again; other files in the folder are kept. */
  output?: string

  /** Build options */
  options?: {
    minify?: boolean
    /** Hosts the package is built for, e.g. ['ios-arm64', 'ios-arm64-simulator'].
     *  They select which builds of the native addons are included. Defaults to
     *  every host bare-stow supports for the language. */
    targets?: string[]
    /** Convert ESM to CJS while packing. Required for engines whose Bare port
     *  can't load ES modules (e.g. JSC on iOS/macOS, QuickJS on Android);
     *  leave off when every target runs an ESM-capable engine (V8).
     *  Defaults to false with 'v8' and to true with the other engines;
     *  'javascriptcore' refuses false. */
    convertEsmToCjs?: boolean
    /** JavaScript engine of the Bare Kit build the app ships. Experimental
     *  apart from 'v8': 'javascriptcore' only with 'swift', 'quickjs' only
     *  with 'kotlin'. An app can only include one engine. Defaults to 'v8'. */
    engine?: 'v8' | 'javascriptcore' | 'quickjs'
    /** Largest frame the worklet accepts over 'bare-rpc', in bytes; a larger
     *  one ends the session. Defaults to 16 MiB. */
    maxFrameSize?: number
    /** Most bytes a 'bare-rpc' stream of the worklet may buffer. Defaults to
     *  16 MiB. */
    maxBufferedBytes?: number
    /** Adds stack traces to the errors the worklet returns. Not for
     *  production builds. Defaults to false. */
    debug?: boolean
    /** Enables pear-wrk-wdk's handle-leak diagnostic (registerHandleLeakCheck),
     *  which repeatedly walks and logs active handles while the worklet is
     *  suspended, to help identify what's keeping the event loop from
     *  reaching idle promptly. Diagnostic only - omit to disable entirely
     *  (no require is emitted into the bundle). Set to `true` to enable with
     *  pear-wrk-wdk's own default tick interval, or a number (ms) to
     *  override how often it logs while suspended. */
    handleLeakCheck?: number | true
  }
}

export interface ResolvedConfig extends WdkBundleConfig {
  /** Absolute path to config file */
  configPath: string
  /** Absolute path of the folder with the package.json and node_modules the
   *  worklet is built from: the folder of the config file, unless another
   *  one was given (`--project-root`). */
  projectRoot: string
  /** Absolute path of the folder of the generated package */
  outputDir: string
}
