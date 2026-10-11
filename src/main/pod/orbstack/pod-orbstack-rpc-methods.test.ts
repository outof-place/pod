import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodOrbstackEvent, PodOrbstackStatus } from '../../../shared/pod-orbstack-types'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { POD_ORBSTACK_METHODS } from './pod-orbstack-rpc-methods'
import { setPodOrbstackService, type PodOrbstackService } from './pod-orbstack-service'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers never read the context.
const ctx = {} as RpcContext

function method(name: string) {
  const found = eraseRpcMethods(POD_ORBSTACK_METHODS).find((entry) => entry.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`missing ${name}`)
  }
  return found
}

function call(name: string, params?: unknown): unknown {
  const entry = method(name)
  // Like the dispatcher: absent or null params parse as {}.
  return entry.handler(entry.params ? entry.params.parse(params ?? {}) : undefined, ctx)
}

function emptyStatus(overrides: Partial<PodOrbstackStatus> = {}): PodOrbstackStatus {
  return {
    install: { appInstalled: true, orbPath: '/bin/orb', dockerPath: null, version: null },
    service: 'running',
    dockerContext: { current: null, currentIsOrbstack: false, orbstackContextExists: false },
    machines: [],
    containers: [],
    links: [],
    sandboxClaudeLogin: false,
    busyWorktreeIds: [],
    errors: [],
    checkedAt: 0,
    ...overrides
  }
}

const status = emptyStatus({
  machines: [
    {
      name: 'pod-web-1',
      state: 'running',
      distro: null,
      distroVersion: null,
      arch: null,
      podOwned: true,
      kind: 'shared',
      worktreeId: null,
      missing: false
    }
  ],
  errors: ['docker stats: timed out']
})

function fakeService(enabled: boolean): PodOrbstackService {
  return {
    isEnabled: () => enabled,
    snapshot: vi.fn(async () => status),
    create: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    start: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const })),
    setDockerPin: vi.fn(() => ({ ok: true as const })),
    setAgentSandbox: vi.fn(() => ({ ok: true as const })),
    setSandboxClaudeLogin: vi.fn(() => ({ ok: true as const })),
    setTemplates: vi.fn(async () => ({ ok: true as const })),
    restart: vi.fn(async () => ({ ok: true as const })),
    stats: vi.fn(async () => ({ tick: 1, sampledAt: 5, machines: [], errors: [] })),
    invalidate: vi.fn(),
    subscribe: vi.fn((emit: (event: PodOrbstackEvent) => void) => {
      subscribers.push(emit)
      return { seed: [], stop: () => subscribers.splice(subscribers.indexOf(emit), 1) }
    })
  }
}

const subscribers: ((event: PodOrbstackEvent) => void)[] = []

function streaming(name: string) {
  const found = eraseRpcMethods(POD_ORBSTACK_METHODS).find((entry) => entry.name === name)
  if (!found || !isStreamingMethod(found)) {
    throw new Error(`missing streaming ${name}`)
  }
  return found
}

afterEach(() => setPodOrbstackService(null))

describe('orbstack.* RPC methods', () => {
  it('names every method under orbstack. and gates them on host-admin', () => {
    expect(POD_ORBSTACK_METHODS.map((entry) => entry.name)).toEqual([
      'orbstack.enabled',
      'orbstack.status',
      'orbstack.machines',
      'orbstack.containers',
      'orbstack.create',
      'orbstack.start',
      'orbstack.stop',
      'orbstack.delete',
      'orbstack.pinDocker',
      'orbstack.setAgentSandbox',
      'orbstack.setSandboxClaudeLogin',
      'orbstack.setTemplates',
      'orbstack.restart',
      'orbstack.stats',
      'orbstack.subscribe',
      'orbstack.unsubscribe'
    ])
    expect(new Set(POD_ORBSTACK_METHODS.map((entry) => entry.permission))).toEqual(
      new Set(['host-admin'])
    )
  })

  it('reports disabled and refuses the rest while Pod OrbStack is off', async () => {
    expect(call('orbstack.enabled')).toEqual({ enabled: false })
    setPodOrbstackService(fakeService(false))
    expect(call('orbstack.enabled')).toEqual({ enabled: false })
    expect(() => call('orbstack.status')).toThrow(/off/)
    expect(() => call('orbstack.create', { worktreeId: 'r::/x' })).toThrow(/off/)
  })

  it('slices one snapshot for machines and containers and forwards actions', async () => {
    const service = fakeService(true)
    setPodOrbstackService(service)
    expect(await call('orbstack.machines')).toEqual({
      machines: status.machines,
      errors: status.errors
    })
    expect(await call('orbstack.containers')).toEqual({
      containers: status.containers,
      errors: status.errors
    })
    await call('orbstack.create', { worktreeId: 'r::/x', displayName: 'x' })
    await call('orbstack.stop', { name: 'pod-web-1' })
    await call('orbstack.delete', { worktreeId: 'r::/x' })
    await call('orbstack.pinDocker', { worktreeId: 'r::/x', pinned: true })
    await call('orbstack.setSandboxClaudeLogin', { enabled: true })
    expect(service.create).toHaveBeenCalledWith({ worktreeId: 'r::/x', displayName: 'x' })
    expect(service.stop).toHaveBeenCalledWith('pod-web-1')
    expect(service.remove).toHaveBeenCalledWith('r::/x', undefined)
    expect(service.setDockerPin).toHaveBeenCalledWith('r::/x', true)
    expect(service.setSandboxClaudeLogin).toHaveBeenCalledWith(true)
  })

  it('rejects malformed params before they reach the service', () => {
    setPodOrbstackService(fakeService(true))
    expect(() => call('orbstack.start', { name: '' })).toThrow()
    expect(() => call('orbstack.pinDocker', { worktreeId: 'r::/x', pinned: 'yes' })).toThrow()
    expect(() => call('orbstack.delete', { worktreeId: 'r::/x', extra: 1 })).toThrow()
  })

  it('passes the status, stats and templates params through', async () => {
    const service = fakeService(true)
    setPodOrbstackService(service)
    await call('orbstack.status')
    await call('orbstack.status', { containers: false })
    expect(service.snapshot).toHaveBeenNthCalledWith(1, { containers: undefined })
    expect(service.snapshot).toHaveBeenNthCalledWith(2, { containers: false })
    expect(await call('orbstack.stats', { names: ['pod-web-1'] })).toMatchObject({ tick: 1 })
    expect(service.stats).toHaveBeenCalledWith(['pod-web-1'])
    await call('orbstack.setTemplates', { enabled: false })
    expect(service.setTemplates).toHaveBeenCalledWith(false)
    expect(() => call('orbstack.status', { containers: 'no' })).toThrow()
  })

  it('streams ready, the service events and end, and stops on unsubscribe', async () => {
    setPodOrbstackService(fakeService(true))
    const cleanups = new Map<string, () => void>()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream reads only these two runtime calls.
    const streamCtx = {
      connectionId: 'c1',
      runtime: {
        registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
        cleanupSubscription: (id: string) => cleanups.get(id)?.()
      }
    } as unknown as RpcContext
    const events: unknown[] = []
    let id = ''
    const done = streaming('orbstack.subscribe').handler(undefined, streamCtx, (event) => {
      events.push(event)
      if (typeof event === 'object' && event && 'subscriptionId' in event) {
        id = String(event.subscriptionId)
      }
    })
    expect(events).toEqual([
      { type: 'ready', subscriptionId: expect.stringMatching(/^orbstack-c1-/), relay: [] }
    ])
    subscribers[0]?.({ type: 'changed' })
    expect(method('orbstack.unsubscribe').handler({ subscriptionId: id }, streamCtx)).toEqual({
      unsubscribed: true
    })
    await done
    expect(events.slice(1)).toEqual([{ type: 'changed' }, { type: 'end' }])
    expect(subscribers).toEqual([])
  })
})
