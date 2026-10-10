import type { ChildProcess } from 'node:child_process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import type { AiVaultServiceParentMessage } from './session-scanner-service-protocol'
import type { SessionTreeRootIdentity } from './session-tree-cache'
import { BoundedMap } from '../../shared/bounded-map'
import { RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS } from '../../shared/runtime-file-watch-limits'
import { SESSION_TREE_CACHE_MAX_ROOTS } from './session-tree-cache-budget'

export type SessionTreeWatchSubscribe = (
  root: string,
  callback: WatcherProcessCallback,
  hooks: WatcherProcessHooks
) => Promise<WatcherProcessSubscription & { identity?: SessionTreeRootIdentity }>

type RootWatch = {
  controller: AbortController
  subscription: WatcherProcessSubscription | null
}

// Retry retired subscriptions promptly once, then let discovery's backoff apply.
export const SESSION_TREE_RESUBSCRIBE_MIN_INTERVAL_MS = 30_000

/** Root subscriptions and their event delivery belong to one scanner child. */
export class AiVaultServiceTreeWatch {
  private child: ChildProcess | null = null
  private readonly watches = new Map<string, RootWatch>()
  private readonly lostAt = new BoundedMap<string, number>({ maxEntries: 128 })
  private pendingDelivery: { settled: boolean } | null = null
  private readonly resetRoots = new Set<string>()

  constructor(private readonly subscribe: SessionTreeWatchSubscribe | null) {}

  get supported(): boolean {
    return this.subscribe !== null
  }

  attach(child: ChildProcess): void {
    this.detach()
    this.child = child
  }

  detach(): void {
    this.child = null
    for (const watch of this.watches.values()) {
      closeRootWatch(watch)
    }
    this.watches.clear()
    this.lostAt.clear()
    this.pendingDelivery = null
    this.resetRoots.clear()
  }

  watch(child: ChildProcess | null, root: string, restart = false): void {
    const subscribe = this.subscribe
    if (!subscribe || !child || child !== this.child) {
      return
    }
    const existing = this.watches.get(root)
    if (existing && !restart) {
      return
    }
    if (existing) {
      this.watches.delete(root)
      this.resetRoots.delete(root)
      closeRootWatch(existing)
      send(child, { type: 'sessionTree', root, state: 'lost' })
    }
    if (this.watches.size >= SESSION_TREE_CACHE_MAX_ROOTS) {
      send(child, { type: 'sessionTree', root, state: 'lost' })
      return
    }
    const watch: RootWatch = { controller: new AbortController(), subscription: null }
    this.watches.set(root, watch)
    const current = (): boolean => this.child === child && this.watches.get(root) === watch
    const lose = (): void => {
      if (!current()) {
        return
      }
      this.watches.delete(root)
      this.resetRoots.delete(root)
      closeRootWatch(watch)
      send(child, { type: 'sessionTree', root, state: 'lost' })
      const now = Date.now()
      const previous = this.lostAt.get(root)
      this.lostAt.set(root, now)
      if (previous === undefined || now - previous >= SESSION_TREE_RESUBSCRIBE_MIN_INTERVAL_MS) {
        this.watch(child, root)
      }
    }
    const reset = (): void => {
      if (current()) {
        this.deliver(child, root, { type: 'sessionTree', root, state: 'reset' })
      }
    }
    subscribe(
      root,
      (error, events) => {
        if (!current()) {
          return
        }
        // Why: Parcel reports FSEvents MustScanSubDirs (dropped events) as an error.
        if (error) {
          lose()
          return
        }
        if (events.length > 0) {
          this.deliver(child, root, {
            type: 'sessionTreeChanges',
            root,
            changes: events
          })
        }
      },
      {
        signal: watch.controller.signal,
        subscribeTimeoutMs: RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS,
        delivery: { includeDirectoryMetadata: true },
        onOverflow: reset,
        onInterruption: reset,
        onTerminalError: lose
      }
    ).then((subscription) => {
      if (!current()) {
        void subscription.unsubscribe().catch(() => undefined)
        return
      }
      watch.subscription = subscription
      send(child, {
        type: 'sessionTree',
        root,
        state: 'live',
        ...(subscription.identity ? { identity: subscription.identity } : {})
      })
    }, lose)
  }

  private deliver(child: ChildProcess, root: string, message: AiVaultServiceParentMessage): void {
    if (this.pendingDelivery) {
      this.resetRoots.add(root)
      return
    }
    if (!child.connected) {
      return
    }
    const delivery = { settled: false }
    const writable = child.send(message, () => {
      delivery.settled = true
      if (this.child !== child || this.pendingDelivery !== delivery) {
        return
      }
      this.pendingDelivery = null
      const roots = [...this.resetRoots]
      this.resetRoots.clear()
      for (const root of roots) {
        if (this.watches.has(root)) {
          this.deliver(child, root, { type: 'sessionTree', root, state: 'reset' })
        }
      }
    })
    if (!writable && !delivery.settled) {
      // Retain one dirty bit per root while the child channel is full.
      this.pendingDelivery = delivery
      this.resetRoots.add(root)
    }
  }
}

function closeRootWatch(watch: RootWatch): void {
  watch.controller.abort()
  void watch.subscription?.unsubscribe().catch(() => undefined)
  watch.subscription = null
}

function send(child: ChildProcess, message: AiVaultServiceParentMessage): void {
  if (child.connected) {
    child.send(message, () => undefined)
  }
}
