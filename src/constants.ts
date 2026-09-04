export const DEFAULT_OUTPUT_DIR = '.wdk'
export const DEFAULT_BUNDLE_FILENAME = 'wdk-worklet.bundle.js'
export const DEFAULT_TYPES_FILENAME = 'index.d.ts'
export const DEFAULT_ENTRY_FILENAME = 'wdk-worklet.generated.js'

export const DEFAULT_BUNDLE_FILENAME_JSONRPC = 'wdk-worklet.bundle'

export const DEFAULT_BUNDLE_PATH = `./.wdk-bundle/${DEFAULT_BUNDLE_FILENAME}`
export const DEFAULT_BUNDLE_PATH_JSONRPC = `./.wdk-bundle/${DEFAULT_BUNDLE_FILENAME_JSONRPC}`
export const DEFAULT_TYPES_PATH = `./${DEFAULT_OUTPUT_DIR}/${DEFAULT_TYPES_FILENAME}`

export const DEFAULT_BUNDLE_BUILD_HOSTS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator', 'android-arm64', 'android-arm', 'android-ia32', 'android-x64']

export const DEFAULT_SWIFT_TARGET = 'app'
export const DEFAULT_ADDONS_YML_PATH = './ios-addons/addons.yml'

// Bare-link addon output directories (relative to project root)
export const DEFAULT_IOS_ADDONS_DIR = './ios-addons'
export const DEFAULT_MACOS_ADDONS_DIR = './mac-addons'
export const DEFAULT_ANDROID_ADDONS_DIR = './android-addons'

// Native addons to link are discovered from the bundle header (see bundler/linked-addons.ts).

// Host triples for each platform
export const BARE_LINK_HOSTS: Record<string, string[]> = {
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
  macos: ['darwin-arm64', 'darwin-x64'],
  android: ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']
}
