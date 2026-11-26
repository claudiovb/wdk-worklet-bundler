export const DEFAULT_OUTPUT_DIR = '.wdk'
export const DEFAULT_BUNDLE_FILENAME = 'wdk-worklet.bundle.js'
export const DEFAULT_TYPES_FILENAME = 'index.d.ts'
export const DEFAULT_ENTRY_FILENAME = 'wdk-worklet.generated.js'

export const DEFAULT_BUNDLE_PATH = `./.wdk-bundle/${DEFAULT_BUNDLE_FILENAME}`
export const DEFAULT_TYPES_PATH = `./${DEFAULT_OUTPUT_DIR}/${DEFAULT_TYPES_FILENAME}`

export const DEFAULT_BUNDLE_BUILD_HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator', 'android-arm64', 'android-arm', 'android-ia32', 'android-x64']

export const JSONRPC_TRANSPORT_REMOVED =
  "the 'jsonrpc' transport is not available on the 1.0.0-rc line (dist-tag `next`). " +
  'It stays on the LTS line: use @tetherto/wdk-worklet-bundler@latest.'

// The published WDK packages import bare-node-runtime. Until they import
// bare-wdk-runtime themselves (tetherto/wdk#133), an override redirects it.
export const RUNTIME_OVERRIDE_PACKAGE = 'bare-node-runtime'
export const RUNTIME_OVERRIDE_SPEC = 'npm:bare-wdk-runtime@^3.0.1'

export const DEFAULT_SWIFT_TARGET = 'app'
export const DEFAULT_ADDONS_YML_PATH = './ios-addons/addons.yml'

// Bare-link addon output directories (relative to project root)
export const DEFAULT_IOS_ADDONS_DIR = './ios-addons'
export const DEFAULT_MACOS_ADDONS_DIR = './mac-addons'
export const DEFAULT_ANDROID_ADDONS_DIR = './android-addons'
export const DEFAULT_LINUX_ADDONS_DIR = './linux-addons'
export const DEFAULT_WINDOWS_ADDONS_DIR = './windows-addons'

// Native addons to link, and the platforms to link them for, are derived from the bundle
// header and from options.targets respectively (see bundler/linked-addons.ts).
