import { getPackageList } from '../../src/config/packages'
import type { WdkBundleConfig } from '../../src/config/types'

const makeConfig = (overrides: Partial<WdkBundleConfig> = {}): WdkBundleConfig =>
  ({ transport: 'bare-rpc', language: 'swift', networks: {}, ...overrides })

describe('getPackageList', () => {
  it('always includes the WDK, its runtime, the Pear Worklet package and the runtime of bare-stow\'s shim', () => {
    const packages = getPackageList(makeConfig())

    // The entry and the shim require them whatever the config, so they are
    // validated and installed upfront instead of surfacing as a packing failure
    expect(packages).toEqual(['@tetherto/wdk', 'bare-wdk-runtime', '@tetherto/pear-wrk-wdk', 'bare-stow-runtime'])
  })

  it('collects network, protocol, module and preload packages without duplicates', () => {
    const packages = getPackageList(makeConfig({
      networks: {
        bitcoin: { package: '@tetherto/wdk-wallet-btc' },
        ethereum: { package: '@tetherto/wdk-wallet-evm' }
      },
      preloadModules: ['@tetherto/wdk-wallet-btc', 'extra-preload']
    }))

    expect(packages).toContain('@tetherto/wdk-wallet-btc')
    expect(packages).toContain('@tetherto/wdk-wallet-evm')
    expect(packages).toContain('extra-preload')
    expect(packages.filter(p => p === '@tetherto/wdk-wallet-btc')).toHaveLength(1)
  })
})
