import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { HeadlessAgentResumeAnchors } from './headless-agent-resume-anchors'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const LEAF = '11111111-1111-4111-8111-11111111111'

function paneKey(agent: number): string {
  return `tab-${agent}:${LEAF}${agent}`
}

function makeHost(agents: number) {
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: Array.from({ length: agents }, (_, agent) => ({
        id: `tab-${agent}`,
        ptyId: `pty-${agent}`,
        worktreeId: WORKTREE_ID,
        title: 'Claude',
        customTitle: null,
        color: null,
        sortOrder: agent,
        createdAt: 1
      }))
    }
  }
  const rows = new Map<string, AgentStatusIpcPayload>()
  const setState = (agent: number, state: 'working' | 'done'): void => {
    rows.set(paneKey(agent), {
      paneKey: paneKey(agent),
      tabId: `tab-${agent}`,
      worktreeId: WORKTREE_ID,
      connectionId: null,
      state,
      prompt: '',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: `session-${agent}` },
      receivedAt: 1,
      stateStartedAt: 1
    })
  }
  const anchors = new HeadlessAgentResumeAnchors({
    hasRenderer: () => false,
    rowsForPane: (key) => (rows.has(key) ? [rows.get(key)!] : []),
    allRows: () => [...rows.values()],
    sessionFor: () => session,
    launchConfigFor: () => undefined,
    writeRecords: (_worktreeId, current, changes) => {
      const records: Record<string, SleepingAgentSessionRecord> = {
        ...current.sleepingAgentSessionsByPaneKey
      }
      for (const [key, record] of Object.entries(changes)) {
        if (record) {
          records[key] = record
        } else {
          delete records[key]
        }
      }
      session = { ...current, sleepingAgentSessionsByPaneKey: records }
    }
  })
  return { anchors, setState, getSession: () => session }
}

describe('HeadlessAgentResumeAnchors', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches a busy minute of 5 agents into a bounded number of session writes', () => {
    const { anchors, setState, getSession } = makeHost(5)
    let events = 0
    // A turn every 10 s per agent, staggered: prompt, 20 tool events, stop.
    for (let second = 0; second < 60; second += 1) {
      for (let agent = 0; agent < 5; agent += 1) {
        const phase = (second + agent * 2) % 10
        setState(agent, phase === 9 ? 'done' : 'working')
        const burst = phase === 0 || phase === 9 ? 1 : 3
        for (let event = 0; event < burst; event += 1) {
          anchors.note(paneKey(agent))
          events += 1
        }
      }
      vi.advanceTimersByTime(1000)
    }
    anchors.flush()

    expect(events).toBeGreaterThan(500)
    // Two state changes per turn, 6 turns, 5 agents = 60 changes; batches cap writes at 1/s.
    expect(anchors.writes).toBeLessThanOrEqual(60)
    expect(Object.keys(getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(5)
    console.log(`anchor writes per minute, 5 agents: ${anchors.writes} for ${events} events`)
  })

  it('writes nothing while the record is already right', () => {
    const { anchors, setState } = makeHost(1)
    setState(0, 'working')
    anchors.syncAll()
    const writes = anchors.writes
    for (let event = 0; event < 50; event += 1) {
      anchors.note(paneKey(0))
    }
    vi.advanceTimersByTime(5000)
    expect(anchors.writes).toBe(writes)
  })

  it('writes at once on syncAll, before startup reaping', () => {
    const { anchors, setState, getSession } = makeHost(2)
    setState(0, 'working')
    setState(1, 'done')
    anchors.syncAll()
    expect(anchors.writes).toBe(1)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[paneKey(0)]).toMatchObject({
      state: 'working',
      origin: 'live'
    })
  })
})
