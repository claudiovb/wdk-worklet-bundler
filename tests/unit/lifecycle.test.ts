import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { EventEmitter } from 'events'
import { generateEntryPoint } from '../../src/generators/entry'
import { generateJsonRpcEntryPoint } from '../../src/generators/entry-jsonrpc'
import type { ResolvedConfig } from '../../src/config/types'

interface Runtime {
  suspendAll: jest.Mock
  resumeAll: jest.Mock
}

interface Agent {
  suspend: jest.Mock
  resume: jest.Mock
}

describe.each([
  ['hrpc', generateEntryPoint],
  ['jsonrpc', generateJsonRpcEntryPoint]
] as const)('%s lifecycle', (_transport, generate) => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdk-lifecycle-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function start (): Promise<{
    bare: EventEmitter
    context: { moduleRuntime?: Runtime }
    agents: Agent[]
    cache: Record<string, { exports: { globalAgent: Agent } }>
    logger: { info: jest.Mock, error: jest.Mock }
  }> {
    const config: ResolvedConfig = {
      networks: {},
      configPath: path.join(dir, 'wdk.config.js'),
      projectRoot: dir,
      resolvedOutput: {
        bundle: path.join(dir, 'bundle.js'),
        types: path.join(dir, 'types.d.ts'),
        addons: { ios: '', macos: '', android: '' },
        addonsYml: path.join(dir, 'addons.yml')
      }
    }
    const entry = await generate(config, dir)
    const bare = new EventEmitter()
    const agents = Array.from({ length: 2 }, () => ({ suspend: jest.fn(), resume: jest.fn() }))
    const logger = { info: jest.fn(), error: jest.fn() }
    const requireStub = (id: string): unknown => {
      if (id === 'bare-node-runtime/global') return {}
      if (id === '@tetherto/wdk') return class WDK {}
      if (id === '@tetherto/pear-wrk-wdk/worklet' || id === '@tetherto/pear-wrk-wdk/jsonrpc') {
        return {
          HRPC: class HRPC {},
          registerRpcHandlers: (): void => {},
          registerJsonRpcHandlers: (): void => {},
          utils: { logger }
        }
      }
      throw new Error('Unexpected require: ' + id)
    }
    const cache: Record<string, { exports: { globalAgent: Agent } }> = {
      'file:///app/node_modules/bare-http1/index.js': { exports: { globalAgent: agents[0] } },
      'file:///app/node_modules/bare-node-runtime/node_modules/bare-https/index.js': { exports: { globalAgent: agents[1] } }
    }
    requireStub.cache = cache
    const code = fs.readFileSync(entry, 'utf8')
    const context = vm.runInNewContext(code + '\ncontext', {
      require: requireStub,
      Bare: bare,
      BareKit: { IPC: {} },
      process: new EventEmitter(),
      console: { log: jest.fn(), error: jest.fn() }
    }) as { moduleRuntime?: Runtime }
    return { bare, context, agents, cache, logger }
  }

  it('registers once without modules and finds a later or replacement runtime', async () => {
    const { bare, context, agents } = await start()
    expect(bare.listenerCount('suspend')).toBe(1)
    expect(bare.listenerCount('resume')).toBe(1)
    expect(() => bare.emit('suspend')).not.toThrow()
    expect(() => bare.emit('resume')).not.toThrow()
    for (const agent of agents) {
      expect(agent.suspend).toHaveBeenCalledTimes(1)
      expect(agent.resume).toHaveBeenCalledTimes(1)
    }

    const first = { suspendAll: jest.fn(), resumeAll: jest.fn() }
    context.moduleRuntime = first
    bare.emit('suspend')
    expect(first.suspendAll).toHaveBeenCalledTimes(1)
    expect(first.suspendAll.mock.contexts[0]).toBe(first)

    const replacement = { suspendAll: jest.fn(), resumeAll: jest.fn() }
    context.moduleRuntime = replacement
    bare.emit('resume')
    expect(replacement.resumeAll).toHaveBeenCalledTimes(1)
    expect(first.resumeAll).not.toHaveBeenCalled()
  })

  it('discovers later HTTP versions, deduplicates agents, and ignores other modules', async () => {
    const { bare, agents, cache } = await start()
    const late = { suspend: jest.fn(), resume: jest.fn() }
    const unrelated = { suspend: jest.fn(), resume: jest.fn() }
    cache['file:///app/node_modules/wallet/node_modules/bare-https/index.js'] = { exports: { globalAgent: late } }
    cache['file:///app/node_modules/alias/node_modules/bare-http1/index.js'] = { exports: { globalAgent: agents[0] } }
    cache['file:///app/unrelated.js'] = { exports: { globalAgent: unrelated } }
    for (const event of ['suspend', 'resume'] as const) {
      bare.emit(event)
      expect(late[event]).toHaveBeenCalledTimes(1)
      expect(agents[0][event]).toHaveBeenCalledTimes(1)
      expect(unrelated[event]).not.toHaveBeenCalled()
    }
  })

  it('isolates synchronous and asynchronous failures for each lifecycle event', async () => {
    const { bare, context, agents, logger } = await start()
    const syncError = new Error('agent failed')
    const asyncError = new Error('module failed')
    const runtime = {
      suspendAll: jest.fn().mockRejectedValue(asyncError),
      resumeAll: jest.fn().mockRejectedValue(asyncError)
    }
    context.moduleRuntime = runtime
    for (const event of ['suspend', 'resume'] as const) {
      agents[0][event].mockImplementation(() => { throw syncError })
      expect(() => bare.emit(event)).not.toThrow()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(agents[1][event]).toHaveBeenCalledTimes(1)
      expect(runtime[event === 'suspend' ? 'suspendAll' : 'resumeAll']).toHaveBeenCalledTimes(1)
    }
    expect(logger.error).toHaveBeenCalledTimes(4)
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), syncError)
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), asyncError)
  })
})
