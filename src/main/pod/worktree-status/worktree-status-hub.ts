// Fork-only (Pod): pushes worktree.ps ranking changes to the clients that opted in.
import type { PodWorktreeStatusChangedEvent } from '../../../shared/pod-worktree-status-event'
import type { RuntimeWorktreePsSummary } from '../../../shared/runtime-types'
import {
  podAgentRowsKey,
  podAgentRowsSignature,
  podNextDecayAt,
  podRankKey,
  podStatusSignature,
  type PodAgentStatusRow
} from './worktree-status-signature'

/** Rank moves after a push wait out this window; the first after a quiet one waits for nothing. */
export const POD_WORKTREE_STATUS_COALESCE_MS = 16

/** Agent-row-only moves (a tool, a prompt, a message) aren't the mark: they trail by this. */
export const POD_AGENT_ROWS_COALESCE_MS = 50

export type PodWorktreeStatusStore = {
  getStatusSnapshot(): PodAgentStatusRow[]
  subscribeStatusRowMutations(listener: () => void): () => void
  subscribeStatusFreshness(listener: () => void): () => void
}

export type PodWorktreeStatusRead = {
  worktrees: readonly RuntimeWorktreePsSummary[]
  snapshotId: string
}

type Subscriber = {
  read: () => Promise<PodWorktreeStatusRead>
  emit: (event: PodWorktreeStatusChangedEvent) => void
  onError: (error: unknown) => void
  // `worktreeStatus.agents`: a change in what a worktree's agent rows show is news too.
  agents: boolean
  // `worktreeStatus.rows`: each event carries its worktree.ps row.
  rows: boolean
  // Null until the first read: that one sets the baseline and emits nothing.
  ranks: Map<string, string> | null
  reading: boolean
  dirty: boolean
  live: boolean
}

type Timer = ReturnType<typeof setTimeout>

/**
 * Listens to the hook status store only while a subscriber exists. A store write whose ranking
 * fields moved (or a row's decay deadline passing) runs each subscriber's own worktree.ps read and
 * emits one event per worktree whose status or mode changed (with its row, for `rows`). The first
 * write after a quiet period is measured on the next turn of the event loop; a read it starts
 * opens a window, and what lands inside it is measured once when it closes. A subscriber that
 * asked for `agents` also reads when only what an agent row shows moved (a tool, a prompt, a
 * message), on a trailing window of its own, and hears of every worktree whose rows changed.
 */
export class PodWorktreeStatusHub {
  private readonly subscribers = new Set<Subscriber>()
  private detach: (() => void) | null = null
  private signature: string | null = null
  // The agent rows' signature, kept only while an `agents` subscriber exists.
  private agentSignature: string | null = null
  // A quiet period's first write, measured once the hook write that made it has finished.
  private leadingFlush: ReturnType<typeof setImmediate> | null = null
  private windowTimer: Timer | null = null
  // A write landed while the window was open.
  private pending = false
  private agentRowsTimer: Timer | null = null
  private decayTimer: Timer | null = null

  constructor(private readonly store: PodWorktreeStatusStore) {}

  subscribe(
    read: Subscriber['read'],
    emit: Subscriber['emit'],
    onError: Subscriber['onError'] = () => {},
    options: { agents?: boolean; rows?: boolean } = {}
  ): () => void {
    const subscriber: Subscriber = {
      read,
      emit,
      onError,
      agents: options.agents === true,
      rows: options.rows === true,
      ranks: null,
      reading: false,
      dirty: false,
      live: true
    }
    this.subscribers.add(subscriber)
    if (!this.detach) {
      this.attach()
    }
    if (subscriber.agents && this.agentSignature === null) {
      this.agentSignature = podAgentRowsSignature(this.store.getStatusSnapshot(), Date.now())
    }
    void this.readFor(subscriber)
    return () => {
      subscriber.live = false
      this.subscribers.delete(subscriber)
      if (this.subscribers.size === 0) {
        this.release()
      } else if (!this.wantsAgents()) {
        this.agentSignature = null
        this.stopAgentRowsTimer()
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  private attach(): void {
    const onInput = (): void => this.observe()
    const stopMutations = this.store.subscribeStatusRowMutations(onInput)
    const stopFreshness = this.store.subscribeStatusFreshness(onInput)
    this.detach = () => {
      stopMutations()
      stopFreshness()
    }
    this.signature = this.measureRank(this.store.getStatusSnapshot(), Date.now())
  }

  private release(): void {
    this.detach?.()
    this.detach = null
    this.signature = null
    this.agentSignature = null
    if (this.leadingFlush) {
      clearImmediate(this.leadingFlush)
    }
    for (const timer of [this.windowTimer, this.decayTimer]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    this.stopAgentRowsTimer()
    this.leadingFlush = null
    this.windowTimer = null
    this.pending = false
    this.decayTimer = null
  }

  private stopAgentRowsTimer(): void {
    if (this.agentRowsTimer) {
      clearTimeout(this.agentRowsTimer)
      this.agentRowsTimer = null
    }
  }

  private wantsAgents(): boolean {
    for (const subscriber of this.subscribers) {
      if (subscriber.agents) {
        return true
      }
    }
    return false
  }

  /** The agent rows' signature, null without an `agents` subscriber. */
  private measureAgentRows(rows: readonly PodAgentStatusRow[], now: number): string | null {
    return this.wantsAgents() ? podAgentRowsSignature(rows, now) : null
  }

  /** The ranking fields' signature; re-arms the decay timer for the rows it read. */
  private measureRank(rows: readonly PodAgentStatusRow[], now: number): string {
    if (this.decayTimer) {
      clearTimeout(this.decayTimer)
      this.decayTimer = null
    }
    const decayAt = podNextDecayAt(rows, now)
    if (decayAt !== null) {
      this.decayTimer = this.arm(() => {
        this.decayTimer = null
        this.observe()
      }, decayAt - now)
    }
    return podStatusSignature(rows, now)
  }

  private observe(): void {
    if (!this.detach) {
      return
    }
    if (!this.agentRowsTimer && this.wantsAgents()) {
      this.agentRowsTimer = this.arm(() => {
        this.agentRowsTimer = null
        this.flushAgentRows()
      }, POD_AGENT_ROWS_COALESCE_MS)
    }
    if (this.leadingFlush) {
      return
    }
    if (this.windowTimer) {
      this.pending = true
      return
    }
    // An immediate, not a microtask: the store's other listeners and the rest of the hook's
    // request run first, and hooks that land in the same turn share the read.
    this.leadingFlush = setImmediate(() => {
      this.leadingFlush = null
      this.flush()
    })
    this.leadingFlush.unref?.()
  }

  /** Everyone reads when the ranking moved; agent-row-only moves are left to their own window. */
  private flush(): void {
    this.pending = false
    const now = Date.now()
    const rows = this.store.getStatusSnapshot()
    const rank = this.measureRank(rows, now)
    // A write that moved nothing read nothing, so it leaves no window to hold the next one back.
    if (rank === this.signature) {
      return
    }
    this.signature = rank
    // The reads below show the agent rows as they are now, so their window has nothing left.
    this.agentSignature = this.measureAgentRows(rows, now)
    this.stopAgentRowsTimer()
    this.windowTimer = this.arm(() => {
      this.windowTimer = null
      if (this.pending) {
        this.flush()
      }
    }, POD_WORKTREE_STATUS_COALESCE_MS)
    for (const subscriber of this.subscribers) {
      void this.readFor(subscriber)
    }
  }

  /** A ranking move never waits here: every write also reaches `flush` through `observe`. */
  private flushAgentRows(): void {
    const agents = this.measureAgentRows(this.store.getStatusSnapshot(), Date.now())
    if (agents === null || agents === this.agentSignature) {
      return
    }
    this.agentSignature = agents
    for (const subscriber of this.subscribers) {
      if (subscriber.agents) {
        void this.readFor(subscriber)
      }
    }
  }

  private arm(callback: () => void, ms: number): Timer {
    const timer = setTimeout(callback, Math.max(0, ms))
    // A pending read never keeps a quitting runtime up.
    timer.unref?.()
    return timer
  }

  /** One read at a time per subscriber; a change during a read asks for one more after it. */
  private async readFor(subscriber: Subscriber): Promise<void> {
    if (subscriber.reading) {
      subscriber.dirty = true
      return
    }
    subscriber.reading = true
    try {
      do {
        subscriber.dirty = false
        let read: PodWorktreeStatusRead
        try {
          read = await subscriber.read()
        } catch (error) {
          // The subscription stays: the next change reads again.
          subscriber.onError(error)
          return
        }
        if (!subscriber.live) {
          return
        }
        this.diff(subscriber, read)
      } while (subscriber.dirty && subscriber.live)
    } finally {
      subscriber.reading = false
    }
  }

  private diff(subscriber: Subscriber, read: PodWorktreeStatusRead): void {
    const previous = subscriber.ranks
    const ranks = new Map<string, string>()
    for (const row of read.worktrees) {
      const key = subscriber.agents
        ? `${podRankKey(row)}\u0002${podAgentRowsKey(row.agents)}`
        : podRankKey(row)
      ranks.set(row.worktreeId, key)
      if (previous && previous.get(row.worktreeId) !== key) {
        subscriber.emit({
          type: 'worktreeStatusChanged',
          worktreeId: row.worktreeId,
          snapshotId: read.snapshotId,
          status: row.status,
          ...(row.workingMode ? { workingMode: row.workingMode } : {}),
          ...(subscriber.rows ? { worktree: row } : {})
        })
      }
    }
    subscriber.ranks = ranks
  }
}
