import { describe, expect, it, vi } from 'vitest'
import type { PodComputerActionsEvent } from '../../../shared/pod-computer-actions-types'
import { denyRpcMethodForCaller } from '../../runtime/rpc/rpc-caller-scope'
import {
  createPodComputerActionLog,
  isPodComputerActionsEnabled,
  observePodComputerActions,
  POD_COMPUTER_ACTION_METHODS
} from './pod-computer-actions'
import { createPodComputerActionsMethods } from './pod-computer-actions-rpc-methods'

function manualLog(enabled = true) {
  let clock = 1_000
  const runs: (() => void)[] = []
  const log = createPodComputerActionLog({
    now: () => clock,
    schedule: (run) => runs.push(run),
    enabled: () => enabled
  })
  return {
    log,
    runs,
    tick: (ms: number) => (clock += ms),
    flush: () => runs.splice(0).forEach((run) => run())
  }
}

type StreamHandler = (
  params: null,
  context: { runtime: unknown; connectionId: string },
  emit: (event: PodComputerActionsEvent) => void
) => Promise<void>

function streamHandler(method: unknown): StreamHandler {
  if (typeof method !== 'object' || method === null || !('handler' in method)) {
    throw new Error('no handler')
  }
  const handler: unknown = method.handler
  if (typeof handler !== 'function') {
    throw new Error('no handler')
  }
  return (params, context, emit) => Promise.resolve(handler(params, context, emit))
}

describe('recent Computer Use actions', () => {
  it('records each action as it finishes and leaves the reads alone', async () => {
    const { log, tick } = manualLog()
    const read = vi.fn(async (_params: unknown) => ({ apps: [] }))
    const click = vi.fn(async (_params: unknown) => {
      tick(40)
      return { ok: true }
    })
    const fail = vi.fn(async (_params: unknown) => {
      throw new Error('element not found')
    })
    const [listApps, observedClick, observedType] = observePodComputerActions(
      [
        { name: 'computer.listApps', handler: read },
        { name: 'computer.click', handler: click },
        { name: 'computer.typeText', handler: fail }
      ] as const,
      log
    )
    expect(listApps.handler).toBe(read)
    await observedClick.handler({ app: 'com.apple.Safari', worktree: 'id:r::/w' })
    await expect(observedType.handler({ app: 'Notes', text: 'x' })).rejects.toThrow(
      'element not found'
    )
    const { seed } = log.subscribe(() => undefined)
    expect(seed).toEqual([
      {
        seq: 1,
        at: 1_000,
        action: 'click',
        app: 'com.apple.Safari',
        worktree: 'id:r::/w',
        session: null,
        ok: true,
        ms: 40
      },
      {
        seq: 2,
        at: 1_040,
        action: 'typeText',
        app: 'Notes',
        worktree: null,
        session: null,
        ok: false,
        ms: 0
      }
    ])
  })

  it('never carries text, set values, keys, coordinates, screenshots or the AX tree', async () => {
    const { log, flush } = manualLog()
    const events: PodComputerActionsEvent[] = []
    log.subscribe((event) => events.push(event))
    const secret = 'hunter2-typed-secret'
    const screenshot = Buffer.from('PNG-pixels-of-a-private-window').toString('base64')
    // What an action's answer can carry back: a fresh screenshot and the accessibility tree.
    const answer = {
      ok: true,
      screenshot: { data: screenshot, mimeType: 'image/png' },
      tree: [{ role: 'AXTextField', title: 'Private Window Title', value: secret }]
    }
    const handlers = observePodComputerActions(
      [...POD_COMPUTER_ACTION_METHODS].map((name) => ({
        name,
        handler: async (_params: unknown) => answer
      })),
      log
    )
    for (const method of handlers) {
      await method.handler({
        app: 'TextEdit',
        text: secret,
        value: secret,
        keys: ['cmd', 'shift', 'p'],
        key: 'Return',
        x: 4321,
        y: 8765,
        element: 'AXSecureTextField'
      })
    }
    flush()
    const text = JSON.stringify([events, log.subscribe(() => undefined).seed])
    for (const needle of [
      secret,
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('hex'),
      screenshot,
      'Private Window Title',
      'AXTextField',
      'AXSecureTextField',
      'shift',
      'Return',
      '4321',
      '8765'
    ]) {
      expect(text).not.toContain(needle)
    }
    const rows = events.flatMap((event) => (event.type === 'actions' ? event.rows : []))
    expect(rows).toHaveLength(POD_COMPUTER_ACTION_METHODS.size)
    for (const row of rows) {
      expect(Object.keys(row).toSorted()).toEqual([
        'action',
        'app',
        'at',
        'ms',
        'ok',
        'seq',
        'session',
        'worktree'
      ])
    }
  })

  it('keeps the last 50, costs no event or timer unwatched, and sends a burst as one frame', () => {
    const { log, runs, flush } = manualLog()
    for (let index = 0; index < 60; index++) {
      log.record('computer.scroll', { app: 'Finder' }, true, 0)
    }
    expect(runs).toHaveLength(0)
    const events: PodComputerActionsEvent[] = []
    const { seed, stop } = log.subscribe((event) => events.push(event))
    expect(seed).toHaveLength(50)
    expect(seed[0]?.seq).toBe(11)
    expect(seed.at(-1)?.seq).toBe(60)
    for (let index = 0; index < 20; index++) {
      log.record('computer.scroll', { app: 'Finder' }, true, 0)
    }
    expect(events).toEqual([])
    expect(runs).toHaveLength(1)
    flush()
    expect(events).toHaveLength(1)
    expect(events[0]?.type === 'actions' && events[0].rows.length).toBe(20)
    stop()
    log.record('computer.scroll', { app: 'Finder' }, true, 0)
    expect(runs).toHaveLength(0)
  })

  it("without Pod's identity runs actions as upstream does and reports nothing", async () => {
    const { log, runs } = manualLog(false)
    const click = vi.fn(async (_params: unknown) => ({ ok: true }))
    const [observed] = observePodComputerActions([{ name: 'computer.click', handler: click }], log)
    await expect(observed?.handler({ app: 'Mail' })).resolves.toEqual({ ok: true })
    expect(click).toHaveBeenCalledOnce()
    expect(log.subscribe(() => undefined).seed).toEqual([])
    expect(runs).toHaveLength(0)
    const [stream] = createPodComputerActionsMethods(log)
    await expect(
      streamHandler(stream)(null, { runtime: {}, connectionId: 'c1' }, () => undefined)
    ).rejects.toThrow('not reported in this build')
    expect(isPodComputerActionsEnabled({}, 'darwin', () => false)).toBe(false)
    expect(isPodComputerActionsEnabled({}, 'darwin', () => true)).toBe(true)
    expect(isPodComputerActionsEnabled({ POD_COMPUTER_ACTIONS: '0' }, 'darwin', () => true)).toBe(
      false
    )
    expect(isPodComputerActionsEnabled({}, 'linux', () => true)).toBe(false)
  })

  it('refuses phones, SSH hosts and paired clients not granted desktop control', () => {
    const [stream, unsubscribe] = createPodComputerActionsMethods(manualLog().log)
    for (const method of [stream, unsubscribe]) {
      expect(method?.permission).toBe('desktop-control')
      const name = method?.name ?? ''
      expect(denyRpcMethodForCaller({ kind: 'owner' }, name, 'desktop-control')).toBeNull()
      expect(denyRpcMethodForCaller({ kind: 'mobile' }, name, 'desktop-control')).not.toBeNull()
      expect(
        denyRpcMethodForCaller({ kind: 'runtime-paired', grants: [] }, name, 'desktop-control')
      ).not.toBeNull()
      expect(
        denyRpcMethodForCaller(
          { kind: 'ssh-bridge', targetId: 't', remoteCliControl: true },
          name,
          'desktop-control'
        )
      ).not.toBeNull()
      expect(
        denyRpcMethodForCaller(
          { kind: 'runtime-paired', grants: ['desktop-control'] },
          name,
          'desktop-control'
        )
      ).toBeNull()
    }
  })

  it('streams the ring, then rows, and ends on unsubscribe', async () => {
    const { log } = manualLog()
    log.record('computer.click', { app: 'Mail' }, true, 0)
    const [stream, unsubscribe] = createPodComputerActionsMethods(log)
    expect(stream?.name).toBe('computer.actions')
    expect(unsubscribe?.name).toBe('computer.unsubscribeActions')
    const cleanups = new Map<string, () => void>()
    const runtime = {
      registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
      cleanupSubscription: (id: string) => cleanups.get(id)?.()
    }
    const events: PodComputerActionsEvent[] = []
    const done = streamHandler(stream)(null, { runtime, connectionId: 'c1' }, (event) =>
      events.push(event)
    )
    const ready = events[0]
    expect(ready?.type).toBe('ready')
    const id = ready?.type === 'ready' ? ready.subscriptionId : ''
    expect(ready?.type === 'ready' && ready.actions.map((row) => row.app)).toEqual(['Mail'])
    runtime.cleanupSubscription(id)
    await done
    expect(events.at(-1)).toEqual({ type: 'end' })
  })
})
