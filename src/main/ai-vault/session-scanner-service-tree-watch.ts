import type { ChildProcess } from 'node:child_process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import type { AiVaultServiceParentMessage } from './session-scanner-service-protocol'

export type SessionTreeWatchSubscribe = (
  root: string,
  callback: WatcherProcessCallback,
  hooks: WatcherProcessHooks
) => Promise<WatcherProcessSubscription>

type RootWatch = {
  controller: AbortController
  subscription: WatcherProcessSubscription | null
}

// Why: FSEvents drops events under system-wide load and Parcel ends the stream
// with an error; resubscribing at once costs the child one cold walk, while a
// root that keeps failing is left for the child to ask about again.
export const SESSION_TREE_RESUBSCRIBE_MIN_INTERVAL_MS = 30_000

/**
 * Watches the transcript roots the scanner child asks about and relays what
 * changed, so the child can rewalk only those directories.
 *
 * Subscriptions belong to one child: a respawned child starts cold and asks
 * again, so nothing it relies on can outlive the process that relied on it.
 */
export class AiVaultServiceTreeWatch {
  private child: ChildProcess | null = null
  private readonly watches = new Map<string, RootWatch>()
  private readonly lostAt = new Map<string, number>()

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
  }

  watch(child: ChildProcess | null, root: string): void {
    const subscribe = this.subscribe
    if (!subscribe || !child || child !== this.child || this.watches.has(root)) {
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
        send(child, { type: 'sessionTree', root, state: 'reset' })
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
          send(child, {
            type: 'sessionTreeChanges',
            root,
            changes: events.map(({ type, path }) => ({ type, path }))
          })
        }
      },
      {
        signal: watch.controller.signal,
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
      send(child, { type: 'sessionTree', root, state: 'live' })
    }, lose)
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
