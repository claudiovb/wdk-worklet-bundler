/**
 * Smoke test: the worklet the bundler generates, running in a real Bare process.
 *
 * The entry is what generateEntryPoint writes for the real WDK with the EVM
 * and Bitcoin wallets, which are devDependencies of this repo. stowBundle
 * packs it for the bare-sidecar target, and the worklet is started as a
 * separate Bare process and reached through the harness bare-stow generates.
 * This file is the host: it calls the worklet over the IPC, as an app does.
 * No chain is reached: the addresses are derived from the seed.
 *
 * Why bare-sidecar, when the apps use bare-kit: it is the target a host in
 * Node can start. The entry, the server provider, the ESM to CJS conversion
 * and the handlers are the same on both targets. The last case packs for
 * bare-kit, to check the native addons it links.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { stowBundle, type StowBundleOptions, type StowBundleResult } from '../../src/bundler'
import { generateEntryPoint } from '../../src/generators/entry'
import { getPackageList } from '../../src/config/packages'
import { findMissingOptionalPeers, validateDependencies } from '../../src/validators/dependencies'
import type { ResolvedConfig } from '../../src/config/types'
import { readStowedBundle } from '../helpers/stow-fixture'

type Transport = ResolvedConfig['transport']
type Payload = Record<string, unknown>

/** Sends a command to the worklet and gives its answer. */
type Call = (command: keyof typeof COMMAND_IDS, payload: Payload) => Promise<Payload>

/** The IPC of bare-stow between the host and the worklet. */
interface Ipc {
  /** Ask the worklet to stop, and give its exit code. */
  terminate: () => Promise<number>
}

/** The bare-rpc client bare-stow generates into the host package. */
interface BareRpcClient {
  request: (command: number) => { send: (data: Buffer) => void, reply: () => Promise<Uint8Array> }
}

/** The harness bare-stow generates for the bare-sidecar target. */
interface Harness {
  /** Wait for the worklet of a Bare process to be ready. */
  connect: (sidecar: object, options: { timeout: number }) => Promise<{ ipc: Ipc, rpc: BareRpcClient }>
}

/** A Bare process running a bundle, from bare-sidecar. */
type Sidecar = new (bundle: string, options: { stdio: string[] }) => object

/** The host class of pear-wrk-wdk for the hrpc transport. */
type HrpcClient = Record<keyof typeof COMMAND_IDS, (payload: Payload) => Promise<Payload>>

const REPO_ROOT = path.resolve(__dirname, '../..')

// Inside the repo, so the entry and the harness resolve its node_modules.
const WORK_DIR = path.join(REPO_ROOT, '.wdk', 'stow-smoke')

// The triple bare-stow names the machine running the test by, such as darwin-arm64.
const HOST = `${process.platform}-${process.arch}`

// How long the worklet gets to report that it is ready, in milliseconds.
const READY_TIMEOUT_MS = 30000
const PACK_TIMEOUT_MS = 120000
const TEST_TIMEOUT_MS = 60000

// The ids of the commands, as src/hrpc/hrpc.json of pear-wrk-wdk assigns them.
const COMMAND_IDS = {
  dispose: 2,
  callMethod: 3,
  initializeWDK: 6,
  getSeedAndEntropyFromMnemonic: 7
}

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// The first accounts of that mnemonic.
const ETHEREUM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const BITCOIN_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'

// Nothing listens on these: no call of the test reaches a chain.
const WDK_CONFIG = JSON.stringify({
  networks: {
    ethereum: { blockchain: 'ethereum', config: { provider: 'http://127.0.0.1:9' } },
    bitcoin: { blockchain: 'bitcoin', config: { host: '127.0.0.1', port: 9, network: 'bitcoin' } }
  }
})

// What every session below answers.
const SESSION = {
  initialized: { status: 'initialized' },
  ethereum: { result: JSON.stringify(ETHEREUM_ADDRESS) },
  bitcoin: { result: JSON.stringify(BITCOIN_ADDRESS) },
  disposed: { status: 'disposed' },
  exitCode: 0
}

const makeConfig = (transport: Transport): ResolvedConfig => ({
  transport,
  language: 'swift',
  networks: {
    ethereum: { package: '@tetherto/wdk-wallet-evm' },
    bitcoin: { package: '@tetherto/wdk-wallet-btc' }
  },
  configPath: path.join(REPO_ROOT, 'wdk.config.js'),
  projectRoot: REPO_ROOT,
  outputDir: path.join(WORK_DIR, 'unused')
})

/**
 * Generate the entry of the config and pack it into `<work dir>/<name>/host`:
 * for the bare-sidecar target and this machine, unless the options say otherwise.
 *
 * @param options.defer - Specifiers to defer besides the missing optional peers.
 */
async function packWorklet (
  name: string,
  transport: Transport,
  options: Partial<StowBundleOptions> = {}
): Promise<StowBundleResult & { hostDir: string }> {
  const config = makeConfig(transport)
  const hostDir = path.join(WORK_DIR, name, 'host')
  const entry = await generateEntryPoint(config, path.join(WORK_DIR, name))
  const { installed } = validateDependencies(getPackageList(config), REPO_ROOT)

  const result = await stowBundle({
    entry,
    out: hostDir,
    projectRoot: REPO_ROOT,
    target: 'bare-sidecar',
    language: { name: 'javascript', module: 'cjs' },
    transport,
    hosts: [HOST],
    ...options,
    defer: [...findMissingOptionalPeers(installed, REPO_ROOT), ...options.defer ?? []]
  })

  return { ...result, hostDir }
}

afterAll(() => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
})

describe('generated worklet in a Bare process', () => {
  let running: Ipc | null = null

  /**
   * Start a packed worklet as a Bare process and connect to it through the
   * harness bare-stow generated.
   *
   * @param options.bundleDir - The folder the bundle is started from. The host package by default.
   * @param options.stderr - Where the errors the worklet writes go. The output of the test by default.
   * @returns The call function of the transport, and the IPC under it.
   */
  async function start (
    hostDir: string,
    transport: Transport,
    { bundleDir = hostDir, stderr = 'inherit' }: { bundleDir?: string, stderr?: 'inherit' | 'ignore' } = {}
  ): Promise<{ call: Call, ipc: Ipc }> {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const harness = require(hostDir) as Harness
    const Sidecar = require('bare-sidecar') as Sidecar
    /* eslint-enable @typescript-eslint/no-require-imports */

    const sidecar = new Sidecar(path.join(bundleDir, 'index.bundle'), { stdio: ['ignore', 'ignore', stderr] })
    const { ipc, rpc } = await harness.connect(sidecar, { timeout: READY_TIMEOUT_MS })
    running = ipc

    if (transport === 'hrpc') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { HRPC } = require('@tetherto/pear-wrk-wdk') as { HRPC: new (ipc: Ipc) => HrpcClient }
      const hrpc = new HRPC(ipc)

      return { call: async (command, payload) => await hrpc[command](payload), ipc }
    }

    const call: Call = async (command, payload) => {
      const request = rpc.request(COMMAND_IDS[command])
      request.send(Buffer.from(JSON.stringify(payload)))

      return JSON.parse(Buffer.from(await request.reply()).toString()) as Payload
    }

    return { call, ipc }
  }

  /** Terminate the worklet and give its exit code. */
  async function terminate (ipc: Ipc): Promise<number> {
    const exitCode = await ipc.terminate()
    running = null

    return exitCode
  }

  /** A whole session: seed, WDK, one address per wallet, dispose, terminate. */
  async function runSession (hostDir: string, transport: Transport): Promise<typeof SESSION> {
    const { call, ipc } = await start(hostDir, transport)

    const { encryptionKey, encryptedSeedBuffer } = await call('getSeedAndEntropyFromMnemonic', { mnemonic: MNEMONIC })
    const initialized = await call('initializeWDK', { encryptionKey, encryptedSeed: encryptedSeedBuffer, config: WDK_CONFIG })
    const ethereum = await call('callMethod', { methodName: 'getAddress', network: 'ethereum', accountIndex: 0 })
    const bitcoin = await call('callMethod', { methodName: 'getAddress', network: 'bitcoin', accountIndex: 0 })
    const disposed = await call('dispose', {})
    const exitCode = await terminate(ipc)

    return { initialized, ethereum, bitcoin, disposed, exitCode } as typeof SESSION
  }

  afterEach(async () => {
    // Only still running when a case failed before it terminated the worklet.
    if (running !== null) await terminate(running).catch(() => {})
  })

  describe.each(['bare-rpc', 'hrpc'] as const)('serving %s', (transport) => {
    let hostDir: string

    beforeAll(async () => {
      ({ hostDir } = await packWorklet(transport, transport))
    }, PACK_TIMEOUT_MS)

    it('should answer a session with the addresses of the seed and exit with code 0', async () => {
      // Act
      const session = await runSession(hostDir, transport)

      // Assert
      expect(session).toEqual(SESSION)
    }, TEST_TIMEOUT_MS)
  })

  describe('converted to CommonJS', () => {
    let hostDir: string

    beforeAll(async () => {
      ({ hostDir } = await packWorklet('converted', 'bare-rpc', { convertEsmToCjs: true }))
    }, PACK_TIMEOUT_MS)

    it('should hold no ES module', () => {
      // Act
      const keys = [...readStowedBundle(path.join(hostDir, 'index.bundle')).keys()]

      // Assert
      expect(keys.filter((key) => key.endsWith('.mjs'))).toEqual([])
    })

    it('should answer the same session', async () => {
      // Act
      const session = await runSession(hostDir, 'bare-rpc')

      // Assert
      expect(session).toEqual(SESSION)
    }, TEST_TIMEOUT_MS)
  })

  describe('when the WDK does not load', () => {
    const ENTRY_KEY = '.wdk/stow-smoke/wdk-not-loaded/wdk-worklet.generated.js'
    let hostDir: string
    let detachedDir: string

    beforeAll(async () => {
      // A deferred specifier is left out of the bundle, for the runtime to
      // resolve. Started from a folder with no node_modules above it, as on a
      // device, the worklet finds no WDK and requiring it throws.
      ({ hostDir } = await packWorklet('wdk-not-loaded', 'bare-rpc', { defer: ['@tetherto/wdk'] }))
      detachedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-stow-smoke-')))
      fs.cpSync(hostDir, detachedDir, { recursive: true })
    }, PACK_TIMEOUT_MS)

    afterAll(() => {
      fs.rmSync(detachedDir, { recursive: true, force: true })
    })

    it('should answer initializeWDK with the error of the load, and exit with code 0', async () => {
      // Arrange: the worklet logs the failed load as an error, which is not shown
      const entryUrl = pathToFileURL(path.join(detachedDir, 'index.bundle', ENTRY_KEY)).href
      const notFound = `MODULE_NOT_FOUND: Cannot find module '@tetherto/wdk' imported from '${entryUrl}'`
      const { call, ipc } = await start(hostDir, 'bare-rpc', { bundleDir: detachedDir, stderr: 'ignore' })
      const { encryptionKey, encryptedSeedBuffer } = await call('getSeedAndEntropyFromMnemonic', { mnemonic: MNEMONIC })

      // Act
      const initializing = call('initializeWDK', { encryptionKey, encryptedSeed: encryptedSeedBuffer, config: WDK_CONFIG })

      // Assert
      await expect(initializing).rejects.toMatchObject({
        code: 'WDK_MANAGER_INIT',
        message: JSON.stringify({
          code: 'WDK_MANAGER_INIT',
          name: 'Error',
          message: `WDK failed to load: ${notFound}`,
          causes: [{ name: 'ModuleError', message: notFound, details: { code: 'MODULE_NOT_FOUND', specifier: '@tetherto/wdk' } }]
        })
      })
      expect(await terminate(ipc)).toBe(0)
    }, TEST_TIMEOUT_MS)
  })
})

describe('generated worklet packed for bare-kit', () => {
  // ELF, the format of an Android library.
  const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

  it('should link the native addon of a package and point its resolution at the linked library', async () => {
    // Arrange: sodium-native, which the WDK loads through require-addon
    const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules/sodium-native/package.json'), 'utf-8')) as { version: string }
    const library = `libsodium-native.${version}.so`

    // Act
    const { hostDir, bundlePath } = await packWorklet('bare-kit', 'bare-rpc', {
      target: 'bare-kit',
      language: { name: 'kotlin', package: 'to.tether.wdk.worklet' },
      hosts: ['android-arm64']
    })

    // Assert
    const bundle = readStowedBundle(bundlePath)
    const resolutions = bundle.resolutions as Record<string, Record<string, unknown>>
    expect(resolutions['/node_modules/sodium-native/binding.js']['.']).toEqual({ addon: `linked:${library}` })
    expect(bundle.addons).toContain(`linked:${library}`)
    expect(fs.readFileSync(path.join(hostDir, 'src/main/addons/arm64-v8a', library)).subarray(0, 4)).toEqual(ELF_MAGIC)
  }, PACK_TIMEOUT_MS)
})
