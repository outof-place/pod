import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import type { PodWorktreeStatusChangedEvent } from '../../../shared/pod-worktree-status-event'
import {
  POD_AGENT_ROWS_COALESCE_MS,
  POD_WORKTREE_STATUS_COALESCE_MS,
  PodWorktreeStatusHub,
  type PodWorktreeStatusRead
} from './worktree-status-hub'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../../shared/runtime-types'
import type { PodAgentStatusRow, PodStatusRow } from './worktree-status-signature'
import { psRow } from './worktree-ps-row.test-fixture'

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
    rows: () => rows,
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

// Settles pending reads without firing the 30-minute decay timer.
const settle = () => vi.advanceTimersByTimeAsync(0)

function makeReader(...answers: [string, RuntimeWorktreePsSummary[]][]) {
  let last = answers[0]
  const read = vi.fn(async (): Promise<PodWorktreeStatusRead> => {
    last = answers.shift() ?? last
    return { snapshotId: last[0], worktrees: last[1] }
  })
  return read
}

const RANK_OF_STATE: Record<PodStatusRow['state'], RuntimeWorktreePsSummary['status']> = {
  working: 'working',
  blocked: 'permission',
  waiting: 'permission',
  done: 'done'
}

/** worktree.ps over the store as it is when the read runs, one row per worktree; notes each start. */
function readFromStore(harness: ReturnType<typeof makeStore>, options: { agents?: boolean } = {}) {
  const startedAt: number[] = []
  const read = vi.fn(async (): Promise<PodWorktreeStatusRead> => {
    startedAt.push(Date.now())
    const worktrees = harness.rows().map((status) =>
      psRow(status.worktreeId ?? '', RANK_OF_STATE[status.state], {
        agents: options.agents
          ? [agentRow(status.paneKey, status.state, { toolName: status.toolName ?? null })]
          : []
      })
    )
    return { snapshotId: `s${startedAt.length}`, worktrees }
  })
  return { read, startedAt }
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
    const read = makeReader(['s1', [psRow('wt-a', 'working')]])
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it('pushes the first change after a quiet period at once, with its worktree.ps row', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness)
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event), undefined, { rows: true })
    await settle()

    const writtenAt = Date.now()
    harness.write([row('p1', 'blocked')])
    await settle()
    expect(Date.now()).toBe(writtenAt)
    expect(events).toEqual([
      {
        type: 'worktreeStatusChanged',
        worktreeId: 'wt-a',
        snapshotId: 's2',
        status: 'permission',
        worktree: psRow('wt-a', 'permission')
      }
    ])

    // Long after the window, the next change is the first of a new quiet period.
    await vi.advanceTimersByTimeAsync(1_000)
    harness.write([row('p1', 'done')])
    await settle()
    expect(events.map((event) => event.status)).toEqual(['permission', 'done'])
  })

  it('holds what follows a push to the end of its window, and the last state wins', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness)
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event), undefined, { rows: true })
    await settle()

    harness.write([row('p1', 'blocked')])
    await settle()
    harness.write([row('p1', 'working')])
    harness.write([row('p1', 'done')])
    await vi.advanceTimersByTimeAsync(1)
    harness.write([row('p1', 'blocked')])
    harness.write([row('p1', 'done')])
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS)
    expect(read).toHaveBeenCalledTimes(3)
    expect(events.map((event) => event.status)).toEqual(['permission', 'done'])
    expect(events[1]?.worktree).toEqual(psRow('wt-a', 'done'))

    // Nothing moved during that window: the hub is quiet again.
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS * 4)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('turns 35 agents changing together into a read per window, not a push per agent', async () => {
    const panes = Array.from({ length: 35 }, (_, index) => `p${index}`)
    let rows = panes.map((pane) => row(pane, 'working', { worktreeId: `wt-${pane}` }))
    const harness = makeStore(rows)
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read, startedAt } = readFromStore(harness)
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event))
    await settle()

    // Their hooks land over 34 ms, one a millisecond.
    const firstAt = Date.now()
    const writtenAt: number[] = []
    for (const pane of panes) {
      rows = rows.map((status) =>
        status.paneKey === pane ? { ...status, state: 'blocked' } : status
      )
      writtenAt.push(Date.now())
      harness.write(rows)
      await vi.advanceTimersByTimeAsync(1)
    }
    const spreadMs = Date.now() - firstAt
    await vi.advanceTimersByTimeAsync(POD_WORKTREE_STATUS_COALESCE_MS * 2)

    const flushes = startedAt.slice(1)
    expect(flushes.length).toBeLessThanOrEqual(
      Math.ceil(spreadMs / POD_WORKTREE_STATUS_COALESCE_MS) + 1
    )
    for (const [index, at] of flushes.entries()) {
      if (index > 0) {
        expect(at - flushes[index - 1]!).toBeGreaterThanOrEqual(POD_WORKTREE_STATUS_COALESCE_MS)
      }
    }
    // A throttle, not a debounce: no write waits past one window while the burst goes on.
    const longestWait = Math.max(
      ...writtenAt.map((at) => Math.min(...flushes.filter((start) => start >= at)) - at)
    )
    expect(longestWait).toBeLessThanOrEqual(POD_WORKTREE_STATUS_COALESCE_MS + 1)
    const heard = new Map(events.map((event) => [event.worktreeId, event.status]))
    expect(heard.size).toBe(35)
    expect([...heard.values()].every((status) => status === 'permission')).toBe(true)
  })

  it('leaves no window behind a write that moved nothing', async () => {
    const working = row('p1', 'working', { toolName: 'Bash' })
    const harness = makeStore([working])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness)
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()

    // A tool update moves no ranking field: no read, and the next real change is not held back.
    harness.write([{ ...working, toolName: 'Edit' }])
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    harness.write([{ ...working, state: 'blocked' }])
    await settle()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'permission' }))
  })

  it('holds what only the agent rows show to the trailing window, so a tool stream reads once a window', async () => {
    let working = row('p1', 'working', { toolName: 'Bash' })
    const harness = makeStore([working])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read, startedAt } = readFromStore(harness, { agents: true })
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event), undefined, { agents: true, rows: true })
    await settle()

    // A tool update is not what the mark shows: it waits as it did before the leading edge.
    harness.write([{ ...working, toolName: 'Edit' }])
    await vi.advanceTimersByTimeAsync(POD_AGENT_ROWS_COALESCE_MS - 1)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(events.map((event) => event.worktree?.agents[0]?.toolName)).toEqual(['Edit'])

    // A working agent's hooks, one every 4 ms for 400 ms.
    const streamFrom = Date.now()
    for (let index = 0; index < 100; index += 1) {
      working = { ...working, toolName: `tool-${index}` }
      harness.write([working])
      await vi.advanceTimersByTimeAsync(4)
    }
    await vi.advanceTimersByTimeAsync(POD_AGENT_ROWS_COALESCE_MS)
    const streamReads = startedAt.filter((at) => at >= streamFrom)
    expect(streamReads.length).toBeLessThanOrEqual(Math.ceil(400 / POD_AGENT_ROWS_COALESCE_MS) + 1)
    expect(events.at(-1)?.worktree?.agents[0]?.toolName).toBe('tool-99')
  })

  it('pushes a state move at once while a tool move waits, and that read covers both', async () => {
    const working = row('p1', 'working', { toolName: 'Bash' })
    const harness = makeStore([working])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness, { agents: true })
    const events: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => events.push(event), undefined, { agents: true, rows: true })
    await settle()

    harness.write([{ ...working, toolName: 'Edit' }])
    await vi.advanceTimersByTimeAsync(10)
    const blockedAt = Date.now()
    harness.write([{ ...working, toolName: 'Edit', state: 'blocked' }])
    await settle()
    expect(Date.now()).toBe(blockedAt)
    expect(events.map((event) => event.status)).toEqual(['permission'])
    expect(events[0]?.worktree?.agents[0]?.toolName).toBe('Edit')

    // The tool move's window has nothing left to read.
    await vi.advanceTimersByTimeAsync(POD_AGENT_ROWS_COALESCE_MS * 2)
    expect(read).toHaveBeenCalledTimes(2)
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
    const rankOnly = makeReader(['s1', [psRow('wt-a', rank)]])
    const rankEvents: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(rankOnly, (event) => rankEvents.push(event))
    const toolMoved = psRow('wt-a', rank, {
      agents: [agentRow('p1', 'working', { toolName: 'Edit' }), agentRow('p2', 'waiting')]
    })
    const agents = makeReader(
      [
        's1',
        [psRow('wt-a', rank, { agents: [agentRow('p1', 'working'), agentRow('p2', 'waiting')] })]
      ],
      ['s2', [toolMoved]],
      [
        's3',
        [
          psRow('wt-a', rank, {
            agents: [
              agentRow('p1', 'done', { lastAssistantMessage: 'All green.' }),
              agentRow('p2', 'waiting')
            ]
          })
        ]
      ]
    )
    const agentEvents: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(agents, (event) => agentEvents.push(event), undefined, {
      agents: true,
      rows: true
    })
    await settle()

    // A tool update moves no ranking field: only the agents subscriber reads, and hears of it.
    harness.write([{ ...working, toolName: 'Edit' }, waiting])
    await vi.advanceTimersByTimeAsync(POD_AGENT_ROWS_COALESCE_MS)
    expect(rankOnly).toHaveBeenCalledTimes(1)
    expect(agents).toHaveBeenCalledTimes(2)
    expect(agentEvents).toEqual([
      {
        type: 'worktreeStatusChanged',
        worktreeId: 'wt-a',
        snapshotId: 's2',
        status: rank,
        worktree: toolMoved
      }
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
    const monitoring = psRow('wt-a', 'working', { workingMode: 'monitoring' })
    const read = makeReader(['s1', [psRow('wt-a', 'working')]], ['s2', [monitoring]])
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    harness.write([row('p1', 'working', { workingMode: 'monitoring' })])
    await settle()
    expect(emit).toHaveBeenCalledWith({
      type: 'worktreeStatusChanged',
      worktreeId: 'wt-a',
      snapshotId: 's2',
      status: 'working',
      workingMode: 'monitoring'
    })
  })

  it('puts the row only on the events of a subscriber that asked for rows', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness)
    const plain: PodWorktreeStatusChangedEvent[] = []
    const withRows: PodWorktreeStatusChangedEvent[] = []
    hub.subscribe(read, (event) => plain.push(event))
    hub.subscribe(read, (event) => withRows.push(event), undefined, { rows: true })
    await settle()

    harness.write([row('p1', 'blocked')])
    await settle()
    expect(plain).toEqual([expect.not.objectContaining({ worktree: expect.anything() })])
    expect(plain[0]).toMatchObject({ worktreeId: 'wt-a', status: 'permission' })
    expect(withRows.map((event) => event.worktree)).toEqual([psRow('wt-a', 'permission')])
  })

  it('re-reads when a row goes stale, which no hook announces', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const read = makeReader(['s1', [psRow('wt-a', 'working')]], ['s2', [psRow('wt-a', 'active')]])
    const emit = vi.fn()
    hub.subscribe(read, emit)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)

    // The deadline is 1 ms past stale; fake timers run an immediate set inside a timer 1 ms later.
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 2)
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
      { snapshotId: 's1', worktrees: [psRow('wt-a', 'working')] },
      { snapshotId: 's2', worktrees: [psRow('wt-a', 'permission')] },
      { snapshotId: 's3', worktrees: [psRow('wt-a', 'inactive')] }
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
      .mockResolvedValueOnce({ snapshotId: 's1', worktrees: [psRow('wt-a', 'working')] })
      .mockRejectedValueOnce(new Error('runtime busy'))
      .mockResolvedValueOnce({ snapshotId: 's3', worktrees: [psRow('wt-a', 'inactive')] })
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
    const read = makeReader(['s1', [psRow('wt-a', 'working')]])
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

  it('drops a change still queued when the last subscriber leaves', async () => {
    const harness = makeStore([row('p1', 'working')])
    const hub = new PodWorktreeStatusHub(harness.store)
    const { read } = readFromStore(harness)
    const stop = hub.subscribe(read, vi.fn())
    await settle()

    harness.write([row('p1', 'blocked')])
    stop()
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('drops a read that finishes after its subscriber left', async () => {
    const { store } = makeStore()
    const hub = new PodWorktreeStatusHub(store)
    const read = makeReader(['s1', [psRow('wt-a', 'working')]])
    const emit = vi.fn()
    hub.subscribe(read, emit)()
    await settle()
    expect(emit).not.toHaveBeenCalled()
    expect(hub.subscriberCount).toBe(0)
  })
})
