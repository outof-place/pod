import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  PodSettingsSetNetworkProxyParams,
  PodSettingsSetParams
} from '../../../shared/rpc-contract/pod-settings-params'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { POD_SETTINGS_METHODS } from './pod-settings-rpc-methods'
import { PodSettingsService, setPodSettingsService } from './pod-settings-service'
import { isPodSettingsRpcEnabled } from './install-pod-settings'

vi.mock('./pod-settings-registration', () => ({ registerSettingsHandlersOnce: vi.fn() }))

const cleanups = new Map<string, () => void>()
const runtime = {
  registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
  cleanupSubscription: (id: string) => cleanups.get(id)?.()
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only read connectionId and the two subscription hooks.
const ctx = { runtime, connectionId: 'conn-1' } as unknown as RpcContext

const methods = eraseRpcMethods(POD_SETTINGS_METHODS)

function call(name: string, params?: unknown, context: RpcContext = ctx): unknown {
  const entry = methods.find((candidate) => candidate.name === name)
  if (!entry || isStreamingMethod(entry)) {
    throw new Error(`missing ${name}`)
  }
  return entry.handler(entry.params ? entry.params.parse(params) : undefined, context)
}

function from(kind: 'local-cli' | 'paired-device'): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy methods read only the caller's kind.
  return { ...ctx, caller: { kind } } as unknown as RpcContext
}

function install() {
  let settings: GlobalSettings = getDefaultSettings('/Users/e2e')
  const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
  const store = {
    getSettings: () => settings,
    onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const write = vi.fn(async (values: Partial<GlobalSettings>) => {
    settings = { ...settings, ...values }
    listeners.forEach((listener) => listener(values))
    return settings
  })
  const service = new PodSettingsService(store, write)
  setPodSettingsService(service)
  return { service, write }
}

afterEach(() => {
  setPodSettingsService(null)
  cleanups.clear()
})

describe('podSettings.* RPC methods', () => {
  it('needs host-admin for every method', () => {
    expect(new Set(POD_SETTINGS_METHODS.map((entry) => entry.permission))).toEqual(
      new Set(['host-admin'])
    )
    expect(POD_SETTINGS_METHODS.map((entry) => entry.name)).toEqual([
      'podSettings.schema',
      'podSettings.get',
      'podSettings.set',
      'podSettings.subscribe',
      'podSettings.unsubscribe',
      'podSettings.getNetworkProxy',
      'podSettings.setNetworkProxy'
    ])
  })

  it('refuses every call while no service is installed', () => {
    expect(() => call('podSettings.get')).toThrow('Pod settings are off in this build.')
  })

  it("takes a write only as the user's, against a revision, without secrets", () => {
    const valid = { values: { theme: 'dark' }, baseRevision: 'r1', reason: 'user' }
    expect(PodSettingsSetParams.safeParse(valid).success).toBe(true)
    expect(PodSettingsSetParams.safeParse({ ...valid, reason: 'agent' }).success).toBe(false)
    expect(
      PodSettingsSetParams.safeParse({ values: { theme: 'dark' }, reason: 'user' }).success
    ).toBe(false)
    for (const key of ['httpProxyUrl', 'opencodeSessionCookie', 'agentDefaultEnv', 'telemetry']) {
      expect(
        PodSettingsSetParams.safeParse({ ...valid, values: { [key]: 'x' } }).success,
        key
      ).toBe(false)
    }
  })

  it('writes through set and answers a stale revision with the current values', async () => {
    const { service, write } = install()
    const { revision } = service.get()
    await expect(
      call('podSettings.set', { values: { theme: 'dark' }, baseRevision: revision, reason: 'user' })
    ).resolves.toMatchObject({ ok: true, values: { theme: 'dark' } })
    await expect(
      call('podSettings.set', {
        values: { theme: 'light' },
        baseRevision: revision,
        reason: 'user'
      })
    ).resolves.toMatchObject({ ok: false, reason: 'conflict', values: { theme: 'dark' } })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('streams a snapshot, then changes, then its end', async () => {
    vi.useFakeTimers()
    const { service } = install()
    const subscribe = methods.find((entry) => entry.name === 'podSettings.subscribe')
    if (!subscribe || !isStreamingMethod(subscribe)) {
      throw new Error('missing podSettings.subscribe')
    }
    const events: unknown[] = []
    const done = subscribe.handler(undefined, ctx, (event) => {
      events.push(event)
    })
    expect(events[0]).toMatchObject({ type: 'ready', revision: service.get().revision })
    await service.set({ terminalFontSize: 20 }, service.get().revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(events[1]).toMatchObject({ type: 'changed', values: { terminalFontSize: 20 } })
    const ready = events[0]
    const subscriptionId =
      ready && typeof ready === 'object' ? String(Reflect.get(ready, 'subscriptionId')) : ''
    expect(call('podSettings.unsubscribe', { subscriptionId: 'pod-settings-other-1' })).toEqual({
      unsubscribed: false
    })
    expect(call('podSettings.unsubscribe', { subscriptionId })).toEqual({ unsubscribed: true })
    await done
    expect(events.at(-1)).toEqual({ type: 'end' })
    vi.useRealTimers()
  })
})

describe('podSettings network proxy methods', () => {
  it('is advertised, so a client shows the proxy row only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.settings.network-proxy.v1')
  })

  it("shows and changes the proxy for this machine's own clients", async () => {
    const { write } = install()
    expect(call('podSettings.getNetworkProxy', undefined, from('local-cli'))).toEqual({
      httpProxyUrl: '',
      httpProxyBypassRules: ''
    })
    await expect(
      call(
        'podSettings.setNetworkProxy',
        { httpProxyUrl: 'http://user:pw@proxy.example.invalid:3128', reason: 'user' },
        from('local-cli')
      )
    ).resolves.toEqual({
      httpProxyUrl: 'http://user:pw@proxy.example.invalid:3128',
      httpProxyBypassRules: ''
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('never hands the proxy URL, which can carry a password, to a paired device', async () => {
    const { write } = install()
    for (const [name, params] of [
      ['podSettings.getNetworkProxy', undefined],
      ['podSettings.setNetworkProxy', { httpProxyUrl: '', reason: 'user' }]
    ] as const) {
      let refused: unknown
      try {
        await call(name, params, from('paired-device'))
      } catch (error) {
        refused = error
      }
      expect(refused, name).toMatchObject({ code: 'forbidden' })
    }
    expect(write).not.toHaveBeenCalled()
  })

  it("takes a proxy change only as the user's", () => {
    const valid = { httpProxyUrl: 'http://proxy.example.invalid', reason: 'user' }
    expect(PodSettingsSetNetworkProxyParams.safeParse(valid).success).toBe(true)
    expect(PodSettingsSetNetworkProxyParams.safeParse({ ...valid, reason: 'agent' }).success).toBe(
      false
    )
    expect(
      PodSettingsSetNetworkProxyParams.safeParse({ ...valid, httpProxyBypassRules: '' }).success
    ).toBe(false)
  })
})

describe('isPodSettingsRpcEnabled', () => {
  it('follows Pod identity unless POD_SETTINGS_RPC overrides it', () => {
    expect(isPodSettingsRpcEnabled({}, () => true)).toBe(true)
    expect(isPodSettingsRpcEnabled({}, () => false)).toBe(false)
    expect(isPodSettingsRpcEnabled({ POD_SETTINGS_RPC: '1' }, () => false)).toBe(true)
    expect(isPodSettingsRpcEnabled({ POD_SETTINGS_RPC: '0' }, () => true)).toBe(false)
  })
})
