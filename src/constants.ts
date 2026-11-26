export const DEFAULT_OUTPUT_DIR = '.wdk'
export const DEFAULT_ENTRY_FILENAME = 'wdk-worklet.generated.js'

// Folder of the generated package, relative to the config file. For Swift,
// bare-stow derives the module name from its basename: wdk-worklet → WdkWorklet.
// For Kotlin the folder name is not used: the namespace of the module and the
// package of its code come from `kotlinPackage`.
export const DEFAULT_PACKAGE_PATH = './wdk-worklet'
export const DEFAULT_KOTLIN_PACKAGE = 'to.tether.wdk.worklet'

// Written into the folder of the generated package, listing what `generate`
// wrote. The next run deletes only what it lists, and refuses a folder that
// holds files without it.
export const PACKAGE_MARKER_FILENAME = '.wdk-worklet-bundler'

export const DEFAULT_TARGET = 'bare-kit'

export const JSONRPC_TRANSPORT_REMOVED =
  "the 'jsonrpc' transport is not available on the 1.0.0-rc line (dist-tag `next`). " +
  'It stays on the LTS line: use @tetherto/wdk-worklet-bundler@latest.'

// What `--install` asks npm for, for the packages whose name alone would
// bring a version this line cannot use.
// RELEASE BLOCKER: the RC line of pear-wrk-wdk is not published yet, so it uses the gh pr that's open for now
export const PEAR_WRK_WDK_INSTALL_SPEC = '@tetherto/pear-wrk-wdk@github:claudiovb/pear-wrk-wdk#1c72715'
export const INSTALL_SPECS: Record<string, string> = {
  '@tetherto/pear-wrk-wdk': PEAR_WRK_WDK_INSTALL_SPEC,
  // The line of the runtime that pairs with the pinned bare-stow.
  'bare-stow-runtime': 'bare-stow-runtime@^0.1.2'
}

// The runtime the published WDK packages import. It does not run on the
// JavaScriptCore and QuickJS engines. Until the packages import
// bare-wdk-runtime themselves (tetherto/wdk#133), an npm override redirects it.
export const LEGACY_RUNTIME_PACKAGE = 'bare-node-runtime'
export const RUNTIME_OVERRIDE_SPEC = 'npm:bare-wdk-runtime@^3.0.1'
