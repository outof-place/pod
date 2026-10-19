// Fork-only (Pod): in a Pod build the classic window's Linear client makes no IPC or RPC call, even
// with podLinear on and a key stored: every export of its three modules, found at run time, stops
// before window.api.linear and callRuntimeRpc. PodNative is Linear's only UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../../shared/product/features'
import type * as RuntimeRpcClient from './runtime-rpc-client'

const rpcCalls: string[] = []

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn(async (_target: unknown, method: string) => {
    rpcCalls.push(method)
    return { connected: true, viewer: null, available: true }
  }),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

const MODULES = {
  client: () => import('./runtime-linear-client'),
  issueMutations: () => import('./runtime-linear-issue-mutations'),
  projectClient: () => import('./runtime-linear-project-client')
}
const LOCAL = { activeRuntimeEnvironmentId: null }
const REMOTE = { activeRuntimeEnvironmentId: 'env-1' }

let ipcCalls: string[] = []

beforeEach(() => {
  rpcCalls.length = 0
  ipcCalls = []
  // A connected key behind every channel: whatever reaches it would answer.
  const record =
    (channel: string) =>
    async (..._args: unknown[]) => {
      ipcCalls.push(channel)
      return { ok: true, connected: true, viewer: null, available: true, items: [] }
    }
  const linear = new Proxy({}, { get: (_target, name) => record(`linear.${String(name)}`) })
  vi.stubGlobal('window', {
    api: { linear, runtimeEnvironments: { call: record('runtimeEnvironments.call') } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** Calls every exported function of the three modules, locally and on a remote runtime. */
async function callEveryExport(): Promise<string[]> {
  const called: string[] = []
  for (const [module, load] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(await load())) {
      if (typeof value !== 'function') {
        continue
      }
      for (const settings of [LOCAL, REMOTE]) {
        called.push(`${module}.${name}`)
        try {
          await Reflect.apply(value, undefined, [settings, 'issue-1', 'body', 'workspace-1'])
        } catch {
          // A refusal, or a class called without new; only the calls count.
        }
      }
    }
  }
  return called
}

describe('the classic Linear client', () => {
  it('reaches IPC and RPC with the classic UI in (the harness sees calls)', async () => {
    await callEveryExport()

    expect(ipcCalls.length).toBeGreaterThan(10)
    expect(rpcCalls.length).toBeGreaterThan(10)
  })

  it('makes no IPC or RPC call in a Pod build, and reads as off', async () => {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
    vi.resetModules()

    const called = await callEveryExport()

    expect(new Set(called).size).toBeGreaterThan(20)
    expect(ipcCalls).toEqual([])
    expect(rpcCalls).toEqual([])
    const { linearStatus, linearListIssues } = await MODULES.client()
    await expect(linearStatus(LOCAL)).resolves.toEqual({
      connected: false,
      viewer: null,
      available: false,
      reason: 'feature-off'
    })
    await expect(linearListIssues(REMOTE)).rejects.toThrow("Pod's window has no Linear.")
  })
})
