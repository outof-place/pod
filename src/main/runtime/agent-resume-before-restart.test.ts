import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import {
  checkStateBeforeRestartOnScreen,
  agentStatusBeforeRestart,
  pendingPaneAgentResume,
  restoredAgentRowBeforeRestart
} from './agent-resume-before-restart'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt',
    connectionId: null,
    state: 'done',
    prompt: '',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-row' },
    receivedAt: 1,
    stateStartedAt: 1,
    ...overrides
  }
}

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-record' },
    prompt: '',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    origin: 'live',
    ...overrides
  }
}

// Screens the shared text lane already reads: a workspace-trust dialog, and Cursor's ready prompt.
const BLOCKED_SCREEN = 'Do you trust the files in this folder?\n1. Yes, proceed\n2. No, exit'
const READY_SCREEN = 'cursor agent\n→'

describe('pendingPaneAgentResume', () => {
  it("names the agent to resume and the anchor's state", () => {
    expect(pendingPaneAgentResume({ record: record(), rows: [], connectionId: null })).toEqual({
      agent: 'claude',
      outcome: 'pending',
      stateBeforeRestart: 'waiting'
    })
  })

  it('leaves out a finished state and a pane with nothing to resume', () => {
    expect(
      pendingPaneAgentResume({ record: undefined, rows: [row()], connectionId: null })
    ).toEqual({ agent: 'claude', outcome: 'pending' })
    expect(pendingPaneAgentResume({ record: undefined, rows: [], connectionId: null })).toBe(
      undefined
    )
    expect(
      pendingPaneAgentResume({
        record: record({ connectionId: 'other-box' }),
        rows: [],
        connectionId: null
      })
    ).toBe(undefined)
  })
})

describe('restoredAgentRowBeforeRestart', () => {
  it('reads only a restored, unconfirmed state that was not done', () => {
    const restored = row({ state: 'working', restoredUnconfirmed: true })
    expect(restoredAgentRowBeforeRestart([restored])).toEqual({ row: restored, state: 'working' })
    expect(restoredAgentRowBeforeRestart([row({ state: 'working' })])).toBe(undefined)
    expect(restoredAgentRowBeforeRestart([row({ restoredUnconfirmed: true })])).toBe(undefined)
  })
})

describe('agentStatusBeforeRestart', () => {
  it('shows the restored state, marked until confirmed', () => {
    const restored = row({ state: 'waiting', restoredUnconfirmed: true, receivedAt: 5 })
    const current = {
      state: 'done' as const,
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey: PANE_KEY,
      stateHistory: []
    }
    expect(agentStatusBeforeRestart(current, restored, false)).toMatchObject({
      state: 'waiting',
      updatedAt: 5,
      agentType: 'claude',
      beforeRestart: true
    })
    expect(agentStatusBeforeRestart(undefined, restored, true)).not.toHaveProperty('beforeRestart')
  })
})

describe('checkStateBeforeRestartOnScreen', () => {
  it('confirms a wait the screen still shows and retires one the ready screen contradicts', () => {
    expect(checkStateBeforeRestartOnScreen('waiting', BLOCKED_SCREEN)).toBe('confirmed')
    expect(checkStateBeforeRestartOnScreen('waiting', READY_SCREEN)).toBe('stale')
    expect(checkStateBeforeRestartOnScreen('waiting', 'compiling…')).toBe(null)
  })

  it('never confirms a turn from its screen, but retires it at a ready or blocked one', () => {
    expect(checkStateBeforeRestartOnScreen('working', 'compiling…')).toBe(null)
    expect(checkStateBeforeRestartOnScreen('working', READY_SCREEN)).toBe('stale')
    expect(checkStateBeforeRestartOnScreen('working', BLOCKED_SCREEN)).toBe('stale')
  })
})
