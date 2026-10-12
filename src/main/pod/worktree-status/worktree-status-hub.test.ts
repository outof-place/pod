import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import type { PodWorktreeStatusChangedEvent } from '../../../shared/pod-worktree-status-event'
import {
  POD_WORKTREE_STATUS_COALESCE_MS,
  PodWorktreeStatusHub,
  type PodWorktreeStatusRead
} from './worktree-status-hub'
import type { RuntimeWorktreeAgentRow } from '../../../shared/runtime-types'
import type { PodAgentStatusRow, PodStatusRow } from './worktree-status-signature'

function row(
  paneKey: string,
  state: PodStatusRow['state'],
  extra: Partial<PodAgentStatusRow> = {}
): PodAgentStatusRow {
  return { paneKey, worktreeId: 'wt-a', state, receivedAt: Date.now(), ...extra }
}

function agentRow(
  paneKey: string,
  state: RuntimeWorktreeAgentRow['state'],
  extra: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state,
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 1,
    ...extra
  }
}

function makeStore(initial: PodAgentStatusRow[] = []) {
  let rows = initial
  const mutations = new Set<() => void>()
  const freshness = new Set<() => void>()
  const store = {
    getStatusSnapshot: vi.fn(() => rows),
    subscribeStatusRowMutations: vi.fn((listener: () => void) => {
      mutations.add(listener)
      return () => mutations.delete(listener)
    }),
    subscribeStatusFreshness: vi.fn((listener: () => void) => {
      freshness.add(listener)
      return () => freshness.delete(listener)
    })
  }
  return {
    store,
    listenerCount: () => mutations.size + freshness.size,
    write(next: PodAgentStatusRow[]) {
      rows = next
      mutations.forEach((listener) => listener())
    },
    renew(next: PodAgentStatusRow[]) {
      rows = next
      freshness.forEach((listener) => listener())
    }
  }
}

type Rank = PodWorktreeStatusRead['worktrees'][number]

// Settles pending reads without firing the 30-minute decay timer.
const settle = () => vi.advanceTimersByTimeAsync(0)

function makeReader(...answers: [string, Rank[]][]) {
  let last = answers[0]
  const read = vi.fn(async (): Promise<PodWorktreeStatusRead> => {
    last = answers.shift() ?? last
    return { snapshotId: last[0], worktrees: last[1] }
  })
  return read
}

describe('PodWorktreeStatusHub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('listens to nothing without a subscriber', () => {
    const { store } = makeStore([row('p1', 'working')])
    new PodWorktreeStatusHub(store)
    expect(store.subscribeStatusRowMutations).not.toHaveBeenCalled()
    expect(store.subscribeStatusFreshness).not.toHaveBeenCalled()
    expect(store.getStatusSnapshot).not.toHaveBeenCalled()
  })

  it('reads a baseline on subscribe and emits nothing for it', async () => {
    const { store } = makeStore()
    const hub = new PodWorktreeStatusHub(store)
    const read = makeReader(['s1', [{ worktreeId: 'wt-a', status: 'working' }]])
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it('turns a burst of state changes into one read and one event per moved worktree', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(
      [
        's1',
        [
          { worktreeId: 'wt-a', status: 'working' },
          { worktreeId: 'wt-b', status: 'active' }
        ]
      ],
      [
        's2',
        [
          { worktreeId: 'wt-a', status: 'permission' },
          { worktreeId: 'wt-b', status: 'active' }
        ]
      ]
    )
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event))
    await settle()

    harness.write([row('p1', 'blocked')])
    harness.write([row('p1', 'waiting')])
    harness.write([row('p1', 'blocked')])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)

    expect(read).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      {
        type: 'worktreeStatusChanged',
        worktreeId: 'wt-a',
        snapshotId: 's2',
        status: 'permission'
      }
    ])
  })

  it('reads nothing for a write that leaves the ranking fields alone', async () => {
    const rows = [row('p1', 'working')]
    const harness = makeStore(rows)
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(['s1', []])
    hub.subscribe(read, vi.fn())
    await settle()

    // A tool update: same pane, state and freshness.
    harness.write([{ ...rows[0], receivedAt: Date.now() }])
    harness.renew([{ ...rows[0], receivedAt: Date.now() }])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS * 2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads for an agent row only for subscribers that asked for agents, and names the worktree', async () => {
    const working = row('p1', 'working', { prompt: 'Fix the login test', toolName: 'Bash' })
    const waiting = row('p2', 'waiting', { prompt: 'Write the notes' })
    const harness = makeStore([working, waiting])
    const hub = new PodWorktreeStatusHub(harness.store)
    const rank = 'permission' as const
    const rankOnly = makeReader(['s1', [{ worktreeId: 'wt-a', status: rank }]])
    const rankEvents: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(rankOnly, (event) => rankEvents.push(event))
    const agents = makeReader(
      [
        's1',
        [
          {
            worktreeId: 'wt-a',
            status: rank,
            agents: [agentRow('p1', 'working'), agentRow('p2', 'waiting')]
          }
        ]
      ],
      [
        's2',
        [
          {
            worktreeId: 'wt-a',
            status: rank,
            agents: [agentRow('p1', 'working', { toolName: 'Edit' }), agentRow('p2', 'waiting')]
          }
        ]
      ],
      [
        's3',
        [
          {
            worktreeId: 'wt-a',
            status: rank,
            agents: [
              agentRow('p1', 'done', { lastAssistantMessage: 'All green.' }),
              agentRow('p2', 'waiting')
            ]
          }
        ]
      ]
    )
    const agentEvents: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(agents, (event) => agentEvents.push(event), undefined, { agents: true })
    await settle()

    // A tool update moves no ranking field: only the agents subscriber reads, and hears of it.
    harness.write([{ ...working, toolName: 'Edit' }, waiting])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(rankOnly).toHaveBeenCalledTimes(1)
    expect(agents).toHaveBeenCalledTimes(2)
    expect(agentEvents).toEqual([
      { type: 'worktreeStatusChanged', worktreeId: 'wt-a', snapshotId: 's2', status: rank }
    ])

    // One agent finishes while the other still waits: the ranking stays, so a ranking subscriber
    // reads (the state moved) but hears nothing; the agents subscriber hears of it.
    harness.write([{ ...working, state: 'done', lastAssistantMessage: 'All green.' }, waiting])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(rankOnly).toHaveBeenCalledTimes(2)
    expect(rankEvents).toEqual([])
    expect(agentEvents.map((event) => event.snapshotId)).toEqual(['s2', 's3'])
  })

  it('stops measuring agent rows when the last subscriber that asked for them leaves', async () => {
    const working = row('p1', 'working', { toolName: 'Bash' })
    const harness = makeStore([working])
    const hub = new PodWorktreeStatusHub(harness.store)
    const rankOnly = makeReader(['s1', []])
    hub.subscribe(rankOnly, vi.fn())
    const stopAgents = hub.subscribe(makeReader(['s1', []]), vi.fn(), undefined, { agents: true })
    await settle()
    stopAgents()

    harness.write([{ ...working, toolName: 'Edit' }])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS * 2)
    expect(rankOnly).toHaveBeenCalledTimes(1)
  })

  it('carries the working mode', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(
      ['s1', [{ worktreeId: 'wt-a', status: 'working' }]],
      ['s2', [{ worktreeId: 'wt-a', status: 'working', workingMode: 'monitoring' }]]
    )
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    harness.write([row('p1', 'working', { workingMode: 'monitoring' })])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(emit).toHaveBeenCalledWith({
      type: 'worktreeStatusChanged',
      worktreeId: 'wt-a',
      snapshotId: 's2',
      status: 'working',
      workingMode: 'monitoring'
    })
  })

  it('re-reads when a row goes stale, which no hook announces', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(
      ['s1', [{ worktreeId: 'wt-a', status: 'working' }]],
      ['s2', [{ worktreeId: 'wt-a', status: 'active' }]]
    )
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(
      AGENT_STATUS_STALE_AFTER_MS + POD_WORKTREE_STATUS_COALESCE_MS + 1
    )
    expect(read).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-a', status: 'active' })
    )
  })

  it('reads once more after a read that a change landed during', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const gate = { release: () => {} }
    const answers: PodWorktreeStatusRead[] = [
      { snapshotId: 's1', worktrees: [{ worktreeId: 'wt-a', status: 'working' }] },
      { snapshotId: 's2', worktrees: [{ worktreeId: 'wt-a', status: 'permission' }] },
      { snapshotId: 's3', worktrees: [{ worktreeId: 'wt-a', status: 'inactive' }] }
    ]
    const read = vi.fn(async () => {
      const answer = answers.shift() ?? { snapshotId: 'end', worktrees: [] }
      if (answer.snapshotId === 's2') {
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      }
      return answer
    })
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()

    harness.write([row('p1', 'blocked')])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    harness.write([row('p1', 'done')])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(read).toHaveBeenCalledTimes(2)
    gate.release()
    await settle()

    expect(read).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls.map(([event]) => event.snapshotId)).toEqual(['s2', 's3'])
  })

  it('keeps the subscription after a failed read', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = vi
      .fn<() => Promise<PodWorktreeStatusRead>>()
      .mockResolvedValue({ snapshotId: 'end', worktrees: [] })
      .mockResolvedValueOnce({
        snapshotId: 's1',
        worktrees: [{ worktreeId: 'wt-a', status: 'working' }]
      })
      .mockRejectedValueOnce(new Error('runtime busy'))
      .mockResolvedValueOnce({
        snapshotId: 's3',
        worktrees: [{ worktreeId: 'wt-a', status: 'inactive' }]
      })
    const emit = vi.fn()
    const onError = vi.fn()
    hub.subscribe(read, emit, onError)
    await settle()

    harness.write([row('p1', 'blocked')])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(onError).toHaveBeenCalledTimes(1)
    harness.write([row('p1', 'done')])
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 's3', status: 'inactive' })
    )
  })

  it('lets go of the store and its timers when the last subscriber leaves', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(['s1', [{ worktreeId: 'wt-a', status: 'working' }]])
    const stopFirst = hub.subscribe(read, vi.fn())
    const stopSecond = hub.subscribe(read, vi.fn())
    expect(harness.store.subscribeStatusRowMutations).toHaveBeenCalledTimes(1)
    await settle()

    stopFirst()
    expect(harness.listenerCount()).toBe(2)
    stopSecond()
    expect(harness.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    harness.write([row('p1', 'blocked')])
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('drops a read that finishes after its subscriber left', async () => {
    const { store } = makeStore()
    const hub = new PodWorktreeStatusHub(store)
    const read = makeReader(['s1', [{ worktreeId: 'wt-a', status: 'working' }]])
    const emit = vi.fn()
    hub.subscribe(read, emit)()
    await settle()
    expect(emit).not.toHaveBeenCalled()
    expect(hub.subscriberCount).toBe(0)
  })

  it('reads again when a terminal starts or ends, and emits where a worktree lost or gained its last one', async () => {
    const harness = makeStore([row('p1', 'working')])
    let fire = (): void => {}
    let terminalListeners = 0
    const hub = new PodWorktreeStatusHub(harness.store, (listener) => {
      fire = listener
      terminalListeners += 1
      return () => {
        terminalListeners -= 1
      }
    })
    const read = makeReader(
      [
        's1',
        [
          { worktreeId: 'wt-a', status: 'active', liveTerminalCount: 2 },
          { worktreeId: 'wt-b', status: 'active', liveTerminalCount: 1 }
        ]
      ],
      [
        's2',
        [
          // Close Terminals: no hook row moved, the terminals are gone.
          { worktreeId: 'wt-a', status: 'active', liveTerminalCount: 0 },
          { worktreeId: 'wt-b', status: 'active', liveTerminalCount: 3 }
        ]
      ]
    )
    const events: PodWorktreeStatusChangedEvent[] = []
    const stop = hub.subscribe(read, (event) => events.push(event))
    await settle()
    expect(terminalListeners).toBe(1)

    fire()
    fire()
    fire()
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)

    expect(read).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      {
        type: 'worktreeStatusChanged',
        worktreeId: 'wt-a',
        snapshotId: 's2',
        status: 'active',
        liveTerminalCount: 0
      }
    ])
    stop()
    expect(terminalListeners).toBe(0)
  })
})
