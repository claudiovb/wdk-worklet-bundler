# @tetherto/wdk-worklet-bundler

CLI tool that generates the worklet package of a WDK (Wallet Development Kit) app. From one config file it packs the wallet and protocol modules you choose into a bundle, and writes a **Swift package** or a **Kotlin module** around it that your app adds as a dependency. The bundle runs in a separate **Bare runtime** thread, isolated from the main loop of the app.

This architecture ensures:

- **Performance:** Heavy cryptographic operations do not block the UI thread.
- **Compatibility:** Provides a Node.js-like environment (via `bare-wdk-runtime`) for standard crypto libraries.
- **Isolation:** Securely encapsulates wallet logic and private keys.

See the [Worklet Bundler documentation](https://docs.wdk.tether.io/tools/worklet-bundler/).

## Release lines

This README describes the `1.0.0-rc` line.

| npm dist-tag | Line | What it generates | Use it for |
| --- | --- | --- | --- |
| `next` | `1.0.0-rc` | A Swift package or Kotlin module, packed with [bare-stow](https://github.com/holepunchto/bare-stow) | Swift and Kotlin apps |
| `latest` | `1.0.0-beta` (LTS) | A bundle file, packed with bare-pack | React Native apps, and native apps on the `jsonrpc` transport |

The two lines do not read the same config. The `jsonrpc` transport and the React Native output exist only on `latest`; its README is on the `main` branch.

---

## Requirements

- Node.js `^22.21.0` or `>=24.9.0`.
- npm. `--install` writes an npm `overrides` entry (see [Runtime](#runtime-bare-wdk-runtime-and-the-override)); yarn and pnpm are not supported on this line.
- For the generated Swift package: Swift tools 5.10, or 6.1 with the JavaScriptCore engine.
- For the generated Kotlin module: Kotlin 2.4 or newer, `compileSdk` 36, `minSdk` 29, and the JitPack repository.

## Installation

```bash
# As a project dependency (recommended)
npm install --save-dev @tetherto/wdk-worklet-bundler@next

# Or run directly without installation
npx @tetherto/wdk-worklet-bundler@next
```

---

## Quick Start

1. **Create** a configuration:

   ```bash
   wdk-worklet-bundler init
   ```

2. **Set** the language and your networks in `wdk.config.js`:

   ```javascript
   module.exports = {
     transport: "bare-rpc",
     language: "swift", // or "kotlin"
     networks: {
       ethereum: { package: "@tetherto/wdk-wallet-evm" },
       bitcoin: { package: "@tetherto/wdk-wallet-btc" },
     },
   };
   ```

3. **Generate** the package:

   ```bash
   wdk-worklet-bundler generate --install
   ```

   This will:
   - Install the packages the config needs, if they are missing
   - Generate the worklet entry point
   - Pack the module graph into the bundle, converting ES modules to CommonJS when the engine needs it
   - Link the native addons the bundle requires, for every host in `options.targets`
   - Write the package into `./wdk-worklet`, next to the config file

4. **Add** the package to your app. See [The generated package](#the-generated-package).

---

## The generated package

Everything the app needs is inside the output folder: the bundle, the native addons, the code that starts the worklet and, with `bare-rpc`, the client that talks to it. Nothing is copied by hand.

### Swift

```
wdk-worklet/
├── Package.swift
├── Sources/WdkWorklet/
│   ├── Harness.swift      start()
│   ├── Client.swift       the bare-rpc client (bare-rpc transport only)
│   └── index.bundle
└── Frameworks/            one xcframework per native addon
```

Add the folder to your project as a local package. The module is named after the folder: `wdk-worklet` gives `WdkWorklet`.

```swift
import BareRPC
import Foundation
import WdkWorklet

let started = try await start(timeout: 20)

// A command is its id and a JSON payload. @tetherto/pear-wrk-wdk defines both.
let payload = try JSONSerialization.data(withJSONObject: ["mnemonic": mnemonic])
let reply = try await started.rpc.request(7, data: payload) // getSeedAndEntropyFromMnemonic

let exitCode = await started.ipc.terminate()
```

### Kotlin

```
wdk-worklet/
├── build.gradle
└── src/main/
    ├── kotlin/to/tether/wdk/worklet/
    │   ├── Harness.kt     start()
    │   └── Client.kt      the bare-rpc client
    ├── assets/to/tether/wdk/worklet/index.bundle
    └── addons/<abi>/      one .so per native addon and ABI
```

Include the folder as a module of your Gradle build, and add JitPack to your repositories: the module takes Bare Kit, the bare-stow host and bare-rpc from there, with floating versions (`v0.2.+`, `v0.6.+`). The package of the code, which is also the namespace of the module, is `kotlinPackage` (default `to.tether.wdk.worklet`).

```kotlin
import to.tether.wdk.worklet.start

val started = start(context)

val reply = started.rpc.request(7uL, """{"mnemonic":"$mnemonic"}""".toByteArray()) // getSeedAndEntropyFromMnemonic

val exitCode = started.ipc.terminate()
```

### The output folder

`generate` owns what it writes into the output folder, and nothing else in it:

- It keeps a list of the files it wrote in `.wdk-worklet-bundler`, inside the folder. On the next run it deletes exactly those, then writes the package again. A file you added (a README, a `.git` folder, your own source file, a build folder) is kept.
- A folder that holds files and has no such list is refused, so pointing `output` at a folder of your own by mistake deletes nothing.
- When a run fails, the package of the earlier run is already removed. Your own files stay.

---

## Transports

| Transport | Languages | Host client |
| --- | --- | --- |
| `bare-rpc` | Swift, Kotlin | Generated into the package (`started.rpc`) |
| `hrpc` | Swift | None generated: the host brings its own HRPC client. There is no HRPC library for Kotlin |

The worklet is the same for both; the transport only selects the server the bundle starts with.

## Engines

`options.engine` selects the JavaScript engine of the Bare Kit build the app ships. Everything apart from `v8` is experimental.

| Engine | Language | Notes |
| --- | --- | --- |
| `v8` (default) | Swift, Kotlin | |
| `javascriptcore` | Swift | The package needs Swift tools 6.1. ES modules are always converted to CommonJS |
| `quickjs` | Kotlin | ES modules are converted to CommonJS by default |

An app can only include one engine.

## What has been run

| Host | Result |
| --- | --- |
| Bare process on the desktop (`bare-sidecar`), both transports | Runs a full session on every `npm test` of this repository |
| Swift on macOS, V8 and JavaScriptCore | Runs a full session; checked by hand |
| Kotlin on the JVM, V8 | Runs a full session; checked by hand |
| Kotlin module for Android, V8 and QuickJS | Builds (AGP 9.3.0, Kotlin 2.4.20); not run on a device |
| iOS, Android devices, QuickJS at runtime, suspend and resume | Not run yet |

A full session is: seed from a mnemonic, `initializeWDK`, an address from the EVM and the Bitcoin wallet, `dispose`, terminate with exit code 0.

---

## Commands

### `generate`

Generates the worklet package.

```bash
wdk-worklet-bundler generate [options]
```

**Options:**

- `-c, --config <path>`: Path to config file.
- `--project-root <dir>`: Folder with the `package.json` and `node_modules` to build from. Default: the folder of the config file. The output folder stays relative to the config file.
- `--install`: Automatically install missing modules listed in your config.
- `--transport <transport>`: Override transport (`bare-rpc` or `hrpc`).
- `--keep-artifacts`: Keep the intermediate `.wdk/` folder (useful for debugging).
- `--source-only`: Generate the entry file but skip packing.
- `--skip-generation`: Skip the entry generation and use the existing file.
- `--dry-run`: Print what would happen without writing files.
- `--no-defer-optional-peers`: Fail at build time if an optional peer dependency (e.g. Ledger support) is missing, instead of deferring it to runtime. See [Optional peer dependencies](#optional-peer-dependencies).
- `-v, --verbose`: Show verbose output.

### `init`

Creates a fresh `wdk.config.js` file. The language has no default: set it before you generate.

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

**Options:**

- `-c, --config <path>`: Path to config file.
- `--project-root <dir>`: Folder with the `package.json` and `node_modules` to check.

### `list-modules`

List available WDK modules.

```bash
wdk-worklet-bundler list-modules [--json]
```

### `clean`

Remove the intermediate `.wdk` folder.

```bash
wdk-worklet-bundler clean [-y]
```

---

## Runtime: `bare-wdk-runtime` and the override

The worklet runs on `bare-wdk-runtime`. The published WDK packages still import `bare-node-runtime`, which does not run on the JavaScriptCore and QuickJS engines. Until the packages import `bare-wdk-runtime` themselves, an npm override redirects the old name:

```json
{
  "overrides": {
    "bare-node-runtime": "npm:bare-wdk-runtime@^3.0.1"
  }
}
```

- `generate --install` writes it into the `package.json` of the project before it installs. An override you already set for that package is left as it is.
- If you install by hand, add it yourself and run `npm install`.
- `generate` checks the install: when the real `bare-node-runtime` is present it warns with the `v8` engine, because the bundle then carries two runtimes, and stops with the other engines.

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
  // ── Transport (required) ──────────────────────────────────
  // 'bare-rpc' → Swift and Kotlin, with a generated client
  // 'hrpc'     → Swift only, no generated client
  transport: "bare-rpc",

  // ── Language (required) ───────────────────────────────────
  // 'swift'  → a Swift package
  // 'kotlin' → a Kotlin module for Android
  language: "kotlin",

  // Kotlin package of the generated code and namespace of the module
  // (default: 'to.tether.wdk.worklet'). Not used with swift.
  kotlinPackage: "to.tether.wdk.worklet",

  // ── Target ────────────────────────────────────────────────
  // The bare-stow target the package is built for. 'bare-kit' is the
  // default and the only value on this line.
  target: "bare-kit",

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

  // ── Modules ───────────────────────────────────────────────
  // Other packages hosted in the worklet and called with callModule.
  // `factory` names the export that creates the module (default: the
  // default export); `events` are forwarded to the host.
  modules: {
    addressBook: {
      package: "@tetherto/wdk-p2p-address-book",
      factory: "createWorkletModule",
      events: ["update"],
    },
  },

  // ── Preload modules ───────────────────────────────────────
  // Packages required before anything else in the worklet.
  preloadModules: [],

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

  // ── Output ────────────────────────────────────────────────
  // Folder of the generated package, relative to the config file
  // (default: './wdk-worklet'). The Swift module is named after it:
  // wdk-worklet → WdkWorklet.
  output: "./wdk-worklet",

  // ── Build options ─────────────────────────────────────────
  options: {
    // Hosts to build for (default: every host of the language).
    // Swift:  ios-arm64, ios-arm64-simulator, ios-x64-simulator,
    //         darwin-arm64, darwin-x64
    // Kotlin: android-arm64, android-arm, android-x64, android-ia32
    targets: ["android-arm64", "android-x64"],

    // JavaScript engine of the Bare Kit build the app ships (default: 'v8').
    // Experimental: 'javascriptcore' (swift only), 'quickjs' (kotlin only).
    engine: "v8",

    // Convert ESM to CJS while packing. Default: false with 'v8', true
    // with the other engines. 'javascriptcore' refuses false.
    convertEsmToCjs: false,

    // Accepted by the config schema but not applied by the bundler yet.
    // Converted modules are always minified; others are packed as they are.
    minify: true,

    // bare-rpc only. Largest frame the worklet accepts, and most bytes a
    // stream of the session may buffer, in bytes (default: 16 MiB each).
    // A larger frame ends the session.
    maxFrameSize: 16777216,
    maxBufferedBytes: 16777216,

    // Add stack traces to the errors the worklet returns (default: false).
    // Not for production builds.
    debug: false,

    // Enable pear-wrk-wdk's handle-leak diagnostic. Use a positive number to
    // override its tick interval; omit to disable (default: disabled).
    handleLeakCheck: true,
  },
};
```

### Removed on this line

A config that still carries one of these fails when it is loaded, with the text below.

| Removed | Use instead |
| --- | --- |
| `transport: 'jsonrpc'` | `@tetherto/wdk-worklet-bundler@latest` |
| `output` as an object (`bundle`, `types`, `addons`, `addonsYml`) | `output` as one folder: the bundle and the addons are written inside it |
| `options.linkAddons`, `options.swiftTarget`, `options.builtins`, `options.sourceMaps`, `options.platforms` | Nothing: the addons are always linked into the package, for the hosts in `options.targets` |
| `--link-addons`, `--skip-link-addons`, `--no-types` | Nothing |

---

## What the host sees

- **Stop** the worklet with `ipc.terminate()`. It disposes the WDK, zeroes the seed and gives the exit code, `0` after a clean stop.
- **`dispose`** takes an argument: `dispose({})`. It answers `{ "status": "disposed" }`.
- **Errors** of a command come back with a `code` and, as the message, a JSON text with `code`, `name` and `message`. `options.debug` adds the stack.
- **An uncaught error** in the worklet ends it: pending calls fail with `WORKER_ERROR`. Start a new worklet; do not reuse the old one.
- **When the WDK itself fails to load**, the worklet still starts, and `initializeWDK` answers `WDK_MANAGER_INIT` with `WDK failed to load:` followed by the cause.
- **Binary fields over `bare-rpc`** are base64 text. Line breaks, missing padding and the URL-safe alphabet are accepted; anything else answers `BAD_REQUEST` naming the field.

The commands, their ids and their payloads are defined by [`@tetherto/pear-wrk-wdk`](https://github.com/tetherto/pear-wrk-wdk).

---

## Troubleshooting

**"Module not found" during generation:**
Run `wdk-worklet-bundler generate --install`. This installs all packages defined in your config.

**`does not export createServerProvider`:**
The installed `@tetherto/pear-wrk-wdk` is from the LTS line. The message gives the install command for the version this line needs.

**`The output folder … holds files that generate did not write`:**
`output` points at a folder that has files and was not generated by the bundler. Point it at a folder of its own, or empty that one.

**`is not a valid Swift module name`:**
The Swift module is named after the output folder. Give `output` a folder name that starts with a letter, such as `./wdk-worklet`.

**`bare-node-runtime is installed`:**
A WDK package brought the old runtime. Add the override from [Runtime](#runtime-bare-wdk-runtime-and-the-override) to `package.json` and run `npm install`.

---

## License

Apache-2.0
