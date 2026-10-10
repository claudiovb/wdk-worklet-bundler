# @tetherto/wdk-worklet-bundler

CLI tool for generating optimized worklet bundles for WDK (Wallet Development Kit) by Tether. This tool packages specific blockchain modules (Wallets, Protocols) into a single artifact designed to run in a separate **Bare runtime** thread, isolated from your main application loop.

This architecture ensures:

- **Performance:** Heavy cryptographic operations do not block the UI thread.
- **Compatibility:** Provides a Node.js-like environment (via `bare-node-runtime`) for standard crypto libraries.
- **Isolation:** Securely encapsulates wallet logic and private keys.

See the [Worklet Bundler documentation](https://docs.wdk.tether.io/tools/worklet-bundler/).

## Transports

The bundler supports two transport modes depending on your target platform:

### HRPC (default) — React Native

Uses binary schema-based RPC via Hyperschema. Best for React Native apps using `@tetherto/pear-wrk-wdk/worklet`. The bundle is output as a `.js` file imported directly as a JS module.

### JSON-RPC — Swift / Kotlin (iOS, macOS, Android)

Uses JSON-RPC 2.0 with length-prefixed framing over BareKit IPC. Required for Swift and Kotlin targets where the worklet is loaded as a **binary bundle** (not a JS module).

When `transport: 'jsonrpc'` is set:

- The bundle is output **without a `.js` extension** (BareKit loads it as binary)
- Set `options.convertEsmToCjs: true` to convert ESM modules to CJS via esbuild while packing. This is **required for iOS/macOS (JavaScriptCore) and QuickJS targets** and optional only for V8. The option defaults to `false` for both transports; the bundler warns when a JSON-RPC bundle is packed with ES modules left in.
- `linkAddons` defaults to `true` — the native addons the bundle requires are discovered from its header and linked automatically for every platform in `options.targets` (see [Native addon discovery](#native-addon-discovery))
- `addons.yml` is generated automatically inside `ios-addons/` for BareKit Swift integration

---

## Installation

```bash
# Global installation
npm install -g @tetherto/wdk-worklet-bundler

# Or as a project dependency (recommended)
npm install --save-dev @tetherto/wdk-worklet-bundler

# Or run directly without installation
npx @tetherto/wdk-worklet-bundler
```

---

## Quick Start — React Native (HRPC)

1. **Initialize** a configuration in your React Native project:

   ```bash
   wdk-worklet-bundler init
   ```

2. **Configure** your networks in `wdk.config.js`:

   ```javascript
   module.exports = {
     networks: {
       ethereum: { package: "@tetherto/wdk-wallet-evm-erc-4337" },
       bitcoin: { package: "@tetherto/wdk-wallet-btc" },
     },
   };
   ```

3. **Generate** the bundle:

   ```bash
   wdk-worklet-bundler generate --install
   ```

4. **Use** it in your app:

   ```typescript
   import { WdkAppProvider } from '@tetherto/pear-wrk-wdk'
   const workletBundle = require('./.wdk-bundle/wdk-worklet.bundle.js')

   function App() {
     return (
       <WdkAppProvider bundle={{ bundle: workletBundle }}>
         {/* Your App Content */}
       </WdkAppProvider>
     )
   }
   ```

---

## Quick Start — Swift / Kotlin (JSON-RPC)

1. **Configure** `wdk.config.js` with `transport: 'jsonrpc'`:

   ```javascript
   module.exports = {
     transport: "jsonrpc",
     networks: {
       ethereum: { package: "@tetherto/wdk-wallet-evm" },
       bitcoin: { package: "@tetherto/wdk-wallet-btc" },
     },
     options: {
       targets: ["ios-arm64", "ios-arm64-simulator", "ios-x64-simulator"], // addons are linked for the platforms these hosts belong to
       convertEsmToCjs: true, // required for JSC and QuickJS; optional for V8
     },
     output: {
       bundle: "./.wdk-bundle/wdk-worklet.mobile.bundle",
     },
   };
   ```

2. **Generate** the bundle:

   ```bash
   wdk-worklet-bundler generate --install
   ```

   This will:
   - Generate the JSON-RPC worklet entry point
   - Pack the module graph with bare-pack into the binary bundle, converting ESM modules to CJS on the way when `convertEsmToCjs: true` (required for JSC and QuickJS)
   - Run `bare-link` for every native addon recorded in the bundle header, writing xcframeworks into `ios-addons/`
   - Generate `ios-addons/addons.yml` for BareKit Swift integration

3. **Copy** the bundle to your Swift project and add the xcframeworks from `ios-addons/`.

---

## Commands

### `generate`

Builds the worklet bundle.

```bash
wdk-worklet-bundler generate [options]
```

**Options:**

- `-c, --config <path>`: Path to config file.
- `--install`: Automatically install missing modules listed in your config.
- `--transport <transport>`: Override transport (`hrpc` or `jsonrpc`).
- `--link-addons`: Force linking native addons even for HRPC.
- `--skip-link-addons`: Skip native addon linking even for JSON-RPC.
- `--keep-artifacts`: Keep the intermediate `.wdk/` folder (useful for debugging).
- `--source-only`: Generate entry files but skip packing.
- `--skip-generation`: Skip artifact generation and use existing files.
- `--dry-run`: Print what would happen without writing files.
- `--no-types`: Skip generating TypeScript definitions.
- `--no-defer-optional-peers`: Fail at build time if an optional peer dependency (e.g. Ledger support) is missing, instead of deferring it to runtime. See [Optional peer dependencies](#optional-peer-dependencies).
- `-v, --verbose`: Show verbose output.

### `init`

Creates a fresh `wdk.config.js` file.

```bash
wdk-worklet-bundler init [options]
```

**Options:**

- `-y, --yes`: Use defaults without prompting.

### `validate`

Checks if your configuration is valid and all required dependencies are installed.

```bash
wdk-worklet-bundler validate [options]
```

### `list-modules`

List available WDK modules.

```bash
wdk-worklet-bundler list-modules [--json]
```

### `clean`

Remove the generated `.wdk` folder.

```bash
wdk-worklet-bundler clean [-y]
```

---

## Optional peer dependencies

Some WDK modules have optional peer dependencies for opt-in features (e.g. `ledger-bitcoin`
for Ledger hardware-wallet support via `@bitcoinerlab/descriptors`). By default, `generate`
defers resolving missing optional peers to runtime instead of failing the build, so apps
that don't use the feature aren't forced to install it. This is logged during `generate`:

```
Deferring missing optional peer dependencies: ledger-bitcoin
```

If your app uses the feature, install the peer yourself before building — once shipped,
a mobile bundle can't `npm install` after the fact. Use `--no-defer-optional-peers` to
fail the build immediately instead of deferring, if you'd rather catch it early.

---

## Configuration Reference (`wdk.config.js`)

```javascript
module.exports = {
  // ── Transport ─────────────────────────────────────────────
  // 'hrpc'    → React Native (default)
  // 'jsonrpc' → Swift / Kotlin (BareKit)
  transport: "jsonrpc",

  // ── Wallet modules ────────────────────────────────────────
  // Map logical network names to WDK wallet packages.
  // Wallet modules are lazy-loaded on first use — they are NOT
  // required at bundle startup, which avoids loading thousands
  // of modules before the runtime is ready.
  networks: {
    ethereum: { package: "@tetherto/wdk-wallet-evm" },
    bitcoin: { package: "@tetherto/wdk-wallet-btc" },
  },

  // ── Protocol modules ──────────────────────────────────────
  protocols: {
    aaveEvm: { package: "@tetherto/wdk-protocol-aave-lending-evm" },
  },

  // ── Preload modules ───────────────────────────────────────
  // Native addons that must be required before anything else.
  preloadModules: ["spark-frost-bare-addon"],

  // ── Allowed methods ───────────────────────────────────────
  // Optional but recommended: without this, callMethod can invoke any
  // method on the resolved account/protocol object, including
  // fund-moving or key-export operations. Listing a network or
  // protocol here restricts it to just the given methods; anything
  // left out stays unrestricted, so you can lock this down one
  // surface at a time.
  allowedMethods: {
    ethereum: {
      methods: ["getAddress", "getBalance", "sendTransaction", "signMessage"],
      protocols: { lending: { aaveEvm: { methods: ["supply", "withdraw"] } } },
    },
  },

  // ── Allowed module methods ────────────────────────────────
  // Optional but recommended: without this, callModule can invoke any
  // method on a bundled module instance (e.g. an address book). Keyed
  // by module name; a module left out stays unrestricted.
  allowedModuleMethods: {
    addressBook: { methods: ["list", "add"] },
  },

  // ── Output paths ──────────────────────────────────────────
  output: {
    // Bundle output path.
    // Default (hrpc):    ./.wdk-bundle/wdk-worklet.bundle.js
    // Default (jsonrpc): ./.wdk-bundle/wdk-worklet.bundle  (no .js — BareKit loads as binary)
    bundle: "./.wdk-bundle/wdk-worklet.mobile.bundle",

    // TypeScript declarations (default: ./.wdk/index.d.ts)
    types: "./.wdk/index.d.ts",

    // Native addon output directories, one per platform in options.targets.
    // Each is cleared and rewritten on every build — keep them dedicated.
    addons: {
      ios: "./ios-addons", // default
      macos: "./mac-addons", // default
      android: "./android-addons", // default
      linux: "./linux-addons", // default
      windows: "./windows-addons", // default
    },

    // addons.yml output path (default: ./ios-addons/addons.yml)
    addonsYml: "./ios-addons/addons.yml",
  },

  // ── Build options ─────────────────────────────────────────
  options: {
    // Minify the generated bundle (default: false).
    // Accepted by the config schema but not applied by the bundler yet.
    minify: true,

    // Generate source maps (default: false).
    // Accepted by the config schema but not applied by the bundler yet.
    sourceMaps: true,

    // bare-pack host targets (default: all iOS + Android targets).
    // Also decides which platforms get native addons: ios-* → ios,
    // darwin-* → macos, android-* → android, linux-* → linux, win32-* → windows.
    targets: ["ios-arm64", "ios-arm64-simulator", "ios-x64-simulator"],

    // Link native addons after bundling, for every platform in `targets`.
    // Defaults to true when transport is 'jsonrpc', false for 'hrpc'.
    linkAddons: true,

    // Swift target name used in addons.yml.
    // Defaults to 'app'. Set this to your Xcode target name if it differs.
    swiftTarget: "MyApp",

    // Convert ESM to CJS while packing (default: false for both transports).
    // Required for iOS/macOS (JSC) and QuickJS; optional only for V8.
    convertEsmToCjs: true,

    // Modules and addons the host runtime embeds (bare-pack `builtins`).
    // Matching specifiers resolve to `builtin:` URLs served by the host
    // instead of being packed or linked. Resolution is version-exact: the
    // href carries the version packed from node_modules, and the host only
    // serves the version it was built with, so each listed addon package
    // must be pinned to the version in the bare-kit release's package-lock
    // (list: bare-kit's shared/builtins.json). A mismatch aborts the worklet
    // at its first require of that addon. Default: none.
    builtins: [{ addon: "bare-fs" }],

    // Enable pear-wrk-wdk's handle-leak diagnostic. Use a positive number to
    // override its tick interval; omit to disable (default: disabled).
    handleLeakCheck: true,
  },
};
```

---

## Native addon discovery

Packing with linked resolution (what `bare-pack --linked` does) resolves every `require.addon()` call in the module graph to a `linked:<artefact>` URL and records the full set in the bundle header. Each URL is a promise that the host app ships a native library with exactly that name (`bare-fs.4.7.4.xcframework` on Apple, `libbare-fs.4.7.4.so` on Android). After packing, the bundler reads that set back from the bundle and runs `bare-link` once per addon package, so:

- Adding a package with native code to your app — directly, transitively, or via `preloadModules` — links it with no bundler change.
- Nothing the bundle never requires is linked, which keeps the native output as small as the bundle needs.
- An addon listed in `options.builtins` resolves to a `builtin:<name>@<version>` URL instead and is not linked: the host runtime already embeds it. The version is the one packed from `node_modules` and the host serves only the version it was built with, so pin those packages to the versions in the bare-kit release's `package-lock.json` or the worklet aborts at its first require of the addon (`No addon registered for 'bare-pipe@4.2.3'` on older Bare, `CANNOT_LOAD: Cannot load addon 'builtin:…'` on newer). bare-link still writes an artefact for a builtin addon that a linked addon depends on, so the output directory can hold a few more entries than the header lists.
- The `Discovered N native addons from bundle header` line in the build output lists what will be linked (`--verbose` prints every package).
- The platforms to link for come from `options.targets`: `ios-*` hosts produce xcframeworks in `output.addons.ios`, `darwin-*` frameworks in `output.addons.macos`, `android-*` shared objects in `output.addons.android`, and `linux-*` / `win32-*` their libraries in `output.addons.linux` / `output.addons.windows`. Each platform is linked with exactly the hosts you packed for it; there is no separate platform list to keep in sync.

Each platform's addon output directory (`output.addons.<platform>`) is cleared before linking, so after a build it contains exactly the addons the header requires — point it at a directory dedicated to this output. After linking, the bundler cross-checks the produced artefacts against the header. An addon that `bare-link` could not produce (the package ships no prebuilds for the target hosts) fails the build, naming the package and hosts — that addon would otherwise crash the worklet the first time it is required on device.

Linking needs the bundle, so `linkAddons` (CLI and programmatic API) runs after `generate` has produced it.

---

## `addons.yml` — BareKit Swift Integration

When `transport: 'jsonrpc'`, the bundler automatically generates `ios-addons/addons.yml` after linking native modules. This file tells BareKit's Swift package manager which xcframeworks to include.

**Default output (`ios-addons/addons.yml`):**

```yaml
targets:
  app:
    dependencies:
      - framework: bare-buffer.3.6.0.xcframework
      - framework: bare-crypto.1.2.0.xcframework
      - framework: sodium-native.4.0.0.xcframework
      # ... all linked frameworks
```

The target name defaults to `app`, which matches the default BareKit Swift setup. If your Xcode target has a different name, set `options.swiftTarget` in your config:

```javascript
options: {
  swiftTarget: "MyApp"; // matches your Xcode target name
}
```

This produces:

```yaml
targets:
  MyApp:
    dependencies:
      - framework: bare-buffer.3.6.0.xcframework
      # ...
```

---

## Two Bundler Options for Swift/Kotlin

If you're targeting Swift or Kotlin, you have two approaches:

**Option A — This bundler (`wdk-worklet-bundler`) with `transport: 'jsonrpc'`**

- Full config-driven workflow: define your networks, run one command, get a bundle + native frameworks + `addons.yml`
- Requires your project to have the WDK wallet packages installed as dependencies
- Best when you want JS-side configurability or multiple network support

**Option B — Minimal bundler (`pear-wrk-wdk-jsonrpc`)**

- A pre-built, minimal worklet with a fixed set of supported networks
- No JS configuration needed — download and drop into your Swift/Kotlin project
- Best for teams that want zero JS setup on the Swift side

Both are valid. The minimal bundler is simpler to consume; this bundler gives you more control over which wallet modules are included.

---

## Troubleshooting

**"Module not found" during generation:**
Run `wdk-worklet-bundler generate --install`. This installs all packages defined in your config.

**Stack overflow / `Maximum call stack size exceeded` at runtime:**
This happens when ESM modules are loaded eagerly at bundle startup. The bundler handles this in two ways:

1. Wallet modules are lazy-loaded via a Proxy — they are only `require()`'d when first accessed, not at startup
2. The ESM→CJS conversion (enabled with `options.convertEsmToCjs: true`, required for JSC and QuickJS) rewrites all ESM syntax to CJS while packing so the engine can load it

If you see this error, make sure you're using a recent version of the bundler that includes both fixes.

**Bundle not loading in Swift (BareKit):**
Ensure the bundle output path does **not** end in `.js`. BareKit loads worklet bundles as binary files — a `.js` extension causes the Swift runtime to treat it as plain text. Use `output.bundle: './.wdk-bundle/wdk-worklet.mobile.bundle'`.

**`addons.yml` target name mismatch:**
If BareKit can't find your frameworks, the `swiftTarget` in `addons.yml` may not match your Xcode target name. Set `options.swiftTarget: 'YourTargetName'` in `wdk.config.js`.

---

## License

Apache-2.0
