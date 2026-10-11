import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import {
  liveAgentResumeRecord,
  resolvePaneAgentResume,
  resumeOriginNamesAnotherHost,
  sameAgentResumeRecord
} from './agent-resume-records'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/tmp/wt'
const LAUNCH_CONFIG = { agentArgs: '--model opus', agentEnv: { FOO: '1' } }

function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'done',
    prompt: 'hello',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'from-row' },
    receivedAt: 1,
    stateStartedAt: 1,
    ...overrides
  }
}

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'from-record' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    launchConfig: LAUNCH_CONFIG,
    origin: 'live',
    ...overrides
  }
}

describe('resolvePaneAgentResume', () => {
  it('resumes a finished row when the pane kept no record', () => {
    expect(
      resolvePaneAgentResume({ record: undefined, rows: [row()], connectionId: null })
    ).toEqual({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'from-row' },
      record: null
    })
  })

  it('resumes the record when the row is gone, with its launch config', () => {
    const kept = record()
    expect(resolvePaneAgentResume({ record: kept, rows: [], connectionId: null })).toEqual({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'from-record' },
      launchConfig: LAUNCH_CONFIG,
      record: kept
    })
  })

  it('prefers a row still mid-turn and borrows the matching record launch config', () => {
    const resume = resolvePaneAgentResume({
      record: record({ providerSession: { key: 'session_id', id: 'from-row' } }),
      rows: [row({ state: 'working' })],
      connectionId: null
    })
    expect(resume).toMatchObject({
      providerSession: { id: 'from-row' },
      launchConfig: LAUNCH_CONFIG,
      record: null
    })
  })

  it('prefers the record over a finished row', () => {
    expect(
      resolvePaneAgentResume({ record: record(), rows: [row()], connectionId: null })
    ).toMatchObject({ providerSession: { id: 'from-record' } })
  })

  it('does not resume a session that ended under its shell', () => {
    const remnant = row({
      providerSessionOnly: true,
      providerSession: { key: 'session_id', id: 'from-record' }
    })
    expect(
      resolvePaneAgentResume({ record: record(), rows: [remnant], connectionId: null })
    ).toBeNull()
    expect(
      resolvePaneAgentResume({ record: undefined, rows: [remnant], connectionId: null })
    ).toBeNull()
  })

  it('refuses a session captured on another machine', () => {
    expect(
      resolvePaneAgentResume({
        record: record({ connectionId: 'ssh-box' }),
        rows: [],
        connectionId: null
      })
    ).toBeNull()
    expect(
      resolvePaneAgentResume({ record: undefined, rows: [row()], connectionId: 'ssh-box' })
    ).toBeNull()
  })

  it('ignores agents it cannot resume', () => {
    expect(
      resolvePaneAgentResume({
        record: undefined,
        rows: [row({ agentType: 'claude', providerSession: { key: 'conversation_id', id: 'x' } })],
        connectionId: null
      })
    ).toBeNull()
  })
})

describe('resumeOriginNamesAnotherHost', () => {
  it('fails open on an unstamped origin and refuses only a known other host', () => {
    expect(resumeOriginNamesAnotherHost(undefined, null)).toBe(false)
    expect(resumeOriginNamesAnotherHost(null, null)).toBe(false)
    expect(resumeOriginNamesAnotherHost('ssh-box', 'ssh-box')).toBe(false)
    expect(resumeOriginNamesAnotherHost('ssh-box', null)).toBe(true)
    expect(resumeOriginNamesAnotherHost(null, 'ssh-box')).toBe(true)
  })
})

describe('liveAgentResumeRecord', () => {
  it('anchors the row as a live record with a blank prompt', () => {
    expect(
      liveAgentResumeRecord({
        row: row({ state: 'working' }),
        worktreeId: WORKTREE_ID,
        launchConfig: LAUNCH_CONFIG,
        existing: record({ capturedAt: 5 }),
        now: 9
      })
    ).toEqual({
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'from-row' },
      connectionId: null,
      prompt: '',
      state: 'working',
      capturedAt: 5,
      updatedAt: 9,
      launchConfig: LAUNCH_CONFIG,
      origin: 'live'
    })
  })

  it('anchors nothing for a remnant row', () => {
    expect(
      liveAgentResumeRecord({
        row: row({ providerSessionOnly: true }),
        worktreeId: WORKTREE_ID,
        launchConfig: undefined,
        existing: undefined,
        now: 1
      })
    ).toBeNull()
  })
})

describe('sameAgentResumeRecord', () => {
  it('ignores timestamps but not state', () => {
    expect(sameAgentResumeRecord(record(), record({ updatedAt: 99 }))).toBe(true)
    expect(sameAgentResumeRecord(record(), record({ state: 'done' }))).toBe(false)
    expect(sameAgentResumeRecord(undefined, record())).toBe(false)
  })
})
