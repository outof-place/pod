import { describe, expect, it, vi } from 'vitest'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import {
  AiVaultServiceTreeWatch,
  SESSION_TREE_RESUBSCRIBE_MIN_INTERVAL_MS,
  type SessionTreeWatchSubscribe
} from './session-scanner-service-tree-watch'
import { AiVaultServiceTestChild } from './session-scanner-service-test-child'

const ROOT = '/home/u/.claude/projects'

type FakeSubscription = {
  root: string
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  resolve: () => void
  reject: (error: Error) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function fakeWatcher(): {
  subscribe: SessionTreeWatchSubscribe
  subscriptions: FakeSubscription[]
} {
  const subscriptions: FakeSubscription[] = []
  const subscribe: SessionTreeWatchSubscribe = (root, callback, hooks) =>
    new Promise<WatcherProcessSubscription>((resolve, reject) => {
      const unsubscribe = vi.fn(async () => undefined)
      subscriptions.push({
        root,
        callback,
        hooks,
        resolve: () => resolve({ unsubscribe }),
        reject,
        unsubscribe
      })
    })
  return { subscribe, subscriptions }
}

function treeMessages(child: AiVaultServiceTestChild): unknown[] {
  return child.sent.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      (message.type === 'sessionTree' || message.type === 'sessionTreeChanges')
  )
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function connectedChild(): AiVaultServiceTestChild {
  return Object.assign(new AiVaultServiceTestChild(), { connected: true })
}

describe('AiVaultServiceTreeWatch', () => {
  it('reports live only once subscribed, then relays changes', async () => {
    const watcher = fakeWatcher()
    const watch = new AiVaultServiceTreeWatch(watcher.subscribe)
    const child = connectedChild()
    watch.attach(child.asChildProcess())

    watch.watch(child.asChildProcess(), ROOT)
    watch.watch(child.asChildProcess(), ROOT)
    expect(watcher.subscriptions).toHaveLength(1)
    // Events before the subscription settles reach a child that has nothing cached yet.
    watcher.subscriptions[0].callback(null, [{ type: 'create', path: `${ROOT}/early.jsonl` }])
    watcher.subscriptions[0].resolve()
    await settle()
    watcher.subscriptions[0].callback(null, [
      { type: 'update', path: `${ROOT}/p/a.jsonl`, isDirectory: false }
    ])

    expect(treeMessages(child)).toEqual([
      {
        type: 'sessionTreeChanges',
        root: ROOT,
        changes: [{ type: 'create', path: `${ROOT}/early.jsonl` }]
      },
      { type: 'sessionTree', root: ROOT, state: 'live' },
      {
        type: 'sessionTreeChanges',
        root: ROOT,
        changes: [{ type: 'update', path: `${ROOT}/p/a.jsonl` }]
      }
    ])
  })

  it('resets on overflow or a watcher restart and loses the root on an error', async () => {
    const watcher = fakeWatcher()
    const watch = new AiVaultServiceTreeWatch(watcher.subscribe)
    const child = connectedChild()
    watch.attach(child.asChildProcess())
    watch.watch(child.asChildProcess(), ROOT)
    watcher.subscriptions[0].resolve()
    await settle()

    watcher.subscriptions[0].hooks.onOverflow?.()
    watcher.subscriptions[0].hooks.onInterruption?.()
    watcher.subscriptions[0].callback(new Error('Events were dropped by the kernel.'), [])
    watcher.subscriptions[0].callback(null, [{ type: 'create', path: `${ROOT}/late.jsonl` }])

    expect(treeMessages(child)).toEqual([
      { type: 'sessionTree', root: ROOT, state: 'live' },
      { type: 'sessionTree', root: ROOT, state: 'reset' },
      { type: 'sessionTree', root: ROOT, state: 'reset' },
      { type: 'sessionTree', root: ROOT, state: 'lost' }
    ])
    expect(watcher.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    // Dropped events end Parcel's stream, so the root is subscribed again at once.
    expect(watcher.subscriptions).toHaveLength(2)
    watcher.subscriptions[1].resolve()
    await settle()
    expect(treeMessages(child).at(-1)).toEqual({ type: 'sessionTree', root: ROOT, state: 'live' })
  })

  it('stops resubscribing a root that keeps failing until the child asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const watcher = fakeWatcher()
    const watch = new AiVaultServiceTreeWatch(watcher.subscribe)
    const child = connectedChild()
    watch.attach(child.asChildProcess())
    watch.watch(child.asChildProcess(), ROOT)
    watcher.subscriptions[0].reject(new Error('ENOENT'))
    await settle()
    watcher.subscriptions[1].reject(new Error('ENOENT'))
    await settle()

    expect(watcher.subscriptions).toHaveLength(2)
    expect(treeMessages(child)).toEqual([
      { type: 'sessionTree', root: ROOT, state: 'lost' },
      { type: 'sessionTree', root: ROOT, state: 'lost' }
    ])
    watch.watch(child.asChildProcess(), ROOT)
    expect(watcher.subscriptions).toHaveLength(3)

    vi.advanceTimersByTime(SESSION_TREE_RESUBSCRIBE_MIN_INTERVAL_MS)
    watcher.subscriptions[2].reject(new Error('ENOENT'))
    await settle()
    expect(watcher.subscriptions).toHaveLength(4)
    vi.useRealTimers()
  })

  it('drops every subscription with the child it served', async () => {
    const watcher = fakeWatcher()
    const watch = new AiVaultServiceTreeWatch(watcher.subscribe)
    const first = connectedChild()
    const second = connectedChild()
    watch.attach(first.asChildProcess())
    watch.watch(first.asChildProcess(), ROOT)
    watch.watch(first.asChildProcess(), '/home/u/.codex/sessions')
    watcher.subscriptions[0].resolve()
    await settle()

    watch.attach(second.asChildProcess())
    expect(watcher.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    expect(watcher.subscriptions[1].hooks.signal?.aborted).toBe(true)
    // A subscription that settles after its child left is released, not reported.
    watcher.subscriptions[1].resolve()
    await settle()
    expect(watcher.subscriptions[1].unsubscribe).toHaveBeenCalledTimes(1)
    watch.watch(first.asChildProcess(), ROOT)
    expect(watcher.subscriptions).toHaveLength(2)
    expect(treeMessages(second)).toEqual([])
  })

  it('does nothing where the host cannot watch', () => {
    const watch = new AiVaultServiceTreeWatch(null)
    const child = connectedChild()
    watch.attach(child.asChildProcess())
    watch.watch(child.asChildProcess(), ROOT)
    expect(watch.supported).toBe(false)
    expect(child.sent).toEqual([])
  })
})

describe('AiVaultScannerServiceClient tree watch', () => {
  it('subscribes the roots its child asks about and releases them with that child', async () => {
    const watcher = fakeWatcher()
    const child = connectedChild()
    const client = new AiVaultScannerServiceClient({
      processFactory: () => child.asChildProcess(),
      init: () => ({ sessionParseCache: null, sessionSearch: null, sessionTreeWatch: true }),
      treeWatch: new AiVaultServiceTreeWatch(watcher.subscribe)
    })
    client.request({ type: 'request', operation: 'scan', options: {} }).catch(() => undefined)

    expect(child.sent[0]).toEqual(expect.objectContaining({ type: 'init', sessionTreeWatch: true }))
    child.emit('message', { type: 'sessionTreeWatch', root: ROOT })
    expect(watcher.subscriptions.map((subscription) => subscription.root)).toEqual([ROOT])
    watcher.subscriptions[0].resolve()
    await settle()
    expect(treeMessages(child)).toEqual([{ type: 'sessionTree', root: ROOT, state: 'live' }])

    child.emit('exit', 1)
    expect(watcher.subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('rejects a watch request without a root as malformed', () => {
    const child = connectedChild()
    const client = new AiVaultScannerServiceClient({
      processFactory: () => child.asChildProcess(),
      init: () => ({ sessionParseCache: null, sessionSearch: null })
    })
    client.request({ type: 'request', operation: 'scan', options: {} }).catch(() => undefined)
    child.emit('message', { type: 'sessionTreeWatch', root: '' })
    expect(child.killed).toBe(true)
    client.dispose()
  })
})
