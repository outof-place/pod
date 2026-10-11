// Fork-only (Pod): pushes worktree.ps ranking changes to the clients that opted in.
import type { PodWorktreeStatusChangedEvent } from '../../../shared/pod-worktree-status-event'
import {
  podAgentRowsKey,
  podAgentRowsSignature,
  podNextDecayAt,
  podRankKey,
  podStatusSignature,
  type PodAgentStatusRow,
  type PodWorktreeRank
} from './worktree-status-signature'

/** A burst of hook writes (a turn ending, a permission prompt) reaches a subscriber as one change. */
export const POD_WORKTREE_STATUS_COALESCE_MS = 50

export type PodWorktreeStatusStore = {
  getStatusSnapshot(): PodAgentStatusRow[]
  subscribeStatusRowMutations(listener: () => void): () => void
  subscribeStatusFreshness(listener: () => void): () => void
}

export type PodWorktreeStatusRead = {
  worktrees: readonly (PodWorktreeRank & { worktreeId: string })[]
  snapshotId: string
}

type Subscriber = {
  read: () => Promise<PodWorktreeStatusRead>
  emit: (event: PodWorktreeStatusChangedEvent) => void
  onError: (error: unknown) => void
  // `worktreeStatus.agents`: a change in what a worktree's agent rows show is news too.
  agents: boolean
  // Null until the first read: that one sets the baseline and emits nothing.
  ranks: Map<string, string> | null
  reading: boolean
  dirty: boolean
  live: boolean
}

type Timer = ReturnType<typeof setTimeout>

/**
 * Listens to the hook status store only while a subscriber exists. A store write whose ranking
 * fields moved (or a row's decay deadline passing) runs each subscriber's own worktree.ps read,
 * after a short coalesce, and emits one event per worktree whose status or mode changed. A
 * subscriber that asked for `agents` also reads when what an agent row shows moved (a tool, a
 * message, a second agent's state under an unchanged ranking), and hears of every worktree whose
 * rows changed.
 */
export class PodWorktreeStatusHub {
  private readonly subscribers = new Set<Subscriber>()
  private detach: (() => void) | null = null
  private signature: string | null = null
  // The agent rows' signature, kept only while an `agents` subscriber exists.
  private agentSignature: string | null = null
  private flushTimer: Timer | null = null
  private decayTimer: Timer | null = null

  constructor(private readonly store: PodWorktreeStatusStore) {}

  subscribe(
    read: Subscriber['read'],
    emit: Subscriber['emit'],
    onError: Subscriber['onError'] = () => {},
    options: { agents?: boolean } = {}
  ): () => void {
    const subscriber: Subscriber = {
      read,
      emit,
      onError,
      agents: options.agents === true,
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
    this.signature = this.measure().rank
  }

  private release(): void {
    this.detach?.()
    this.detach = null
    this.signature = null
    this.agentSignature = null
    for (const timer of [this.flushTimer, this.decayTimer]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    this.flushTimer = null
    this.decayTimer = null
  }

  private wantsAgents(): boolean {
    for (const subscriber of this.subscribers) {
      if (subscriber.agents) {
        return true
      }
    }
    return false
  }

  /** Signatures of the ranking fields and, for `agents` subscribers, of the agent rows; re-arms
   *  the decay timer for the rows it read. */
  private measure(): { rank: string; agents: string | null } {
    const now = Date.now()
    const rows = this.store.getStatusSnapshot()
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
    return {
      rank: podStatusSignature(rows, now),
      agents: this.wantsAgents() ? podAgentRowsSignature(rows, now) : null
    }
  }

  /** A store write only opens the window; the snapshot is measured once, when it closes. */
  private observe(): void {
    if (!this.detach || this.flushTimer) {
      return
    }
    this.flushTimer = this.arm(() => {
      this.flushTimer = null
      const next = this.measure()
      const rankMoved = next.rank !== this.signature
      const agentsMoved = next.agents !== null && next.agents !== this.agentSignature
      this.signature = next.rank
      this.agentSignature = next.agents
      if (!rankMoved && !agentsMoved) {
        return
      }
      for (const subscriber of this.subscribers) {
        if (rankMoved || subscriber.agents) {
          void this.readFor(subscriber)
        }
      }
    }, POD_WORKTREE_STATUS_COALESCE_MS)
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
          ...(row.workingMode ? { workingMode: row.workingMode } : {})
        })
      }
    }
    subscriber.ranks = ranks
  }
}
