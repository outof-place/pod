// A host with no renderer resumes a pane's terminal agent with its saved session id, after a
// daemon loss (the pane is restored pending) and after a worktree sleep.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = makePaneKey('host-tab', HEADLESS_LEAF_ID)

function claudeRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    state: 'done',
    prompt: 'fix the bug',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-row' },
    receivedAt: 1,
    stateStartedAt: 1,
    ...overrides
  }
}

function sleepRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-slept' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    launchConfig: { agentArgs: '--model opus', agentEnv: {} },
    origin: 'worktree-sleep',
    ...overrides
  }
}

function makeRuntime(opts: {
  rows?: AgentStatusIpcPayload[]
  session?: Partial<WorkspaceSessionState>
}) {
  let rows = opts.rows ?? []
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal(opts.session)
  )
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getAgentProviderSessionRowsForPane: (paneKey) => rows.filter((row) => row.paneKey === paneKey),
    getAgentProviderSessionSnapshot: () => rows
  })
  const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const setRows = (next: AgentStatusIpcPayload[]): void => {
    rows = next
  }
  return { runtime, spawn, getSession, setRows }
}

function openPane(runtime: InstanceType<typeof OrcaRuntimeService>) {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'user'
  })
}

describe('headless terminal-agent resume', () => {
  it('resumes the restored pane with the session its status row names', async () => {
    const { runtime, spawn } = makeRuntime({ rows: [claudeRow()] })

    await openPane(runtime)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/^claude .*'--resume' 'session-row'$/),
        launchAgent: 'claude',
        resumeProviderSession: { key: 'session_id', id: 'session-row' },
        sessionId: 'persisted-pty'
      })
    )
  })

  it('resumes from the sleep record with its launch config and spends the record', async () => {
    const { runtime, spawn, getSession } = makeRuntime({
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepRecord() } }
    })

    await openPane(runtime)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude '--model' 'opus' '--resume' 'session-slept'",
        resumeProviderSession: { key: 'session_id', id: 'session-slept' }
      })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('opens a plain shell when the agent exited under it', async () => {
    const { runtime, spawn } = makeRuntime({
      rows: [claudeRow({ providerSessionOnly: true })],
      session: {
        sleepingAgentSessionsByPaneKey: {
          [PANE_KEY]: sleepRecord({
            origin: 'live',
            providerSession: { key: 'session_id', id: 'session-row' }
          })
        }
      }
    })

    await openPane(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0].command).toBeUndefined()
    expect(spawn.mock.calls[0][0].resumeProviderSession).toBeUndefined()
  })

  it('keeps a live anchor in step with the rows and retires it when the agent exits', () => {
    const { runtime, getSession, setRows } = makeRuntime({
      rows: [claudeRow({ state: 'working' })]
    })

    runtime.syncHeadlessAgentResumeAnchors()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'live',
      state: 'working',
      providerSession: { id: 'session-row' },
      prompt: ''
    })

    setRows([claudeRow({ providerSessionOnly: true })])
    runtime.syncHeadlessAgentResumeAnchors()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('retires the anchor at SessionEnd and when its tab closes', () => {
    const { runtime, getSession } = makeRuntime({ rows: [claudeRow()] })
    runtime.syncHeadlessAgentResumeAnchors()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()

    runtime.noteHeadlessAgentSessionEnded(PANE_KEY, 'session-row')
    runtime.syncHeadlessAgentResumeAnchors()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('drops the pane records with its tab when the tab is closed', async () => {
    const { runtime, getSession } = makeRuntime({
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepRecord() } }
    })

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', {
      reason: 'user',
      force: true
    })

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('keeps the shell-only behavior behind ORCA_HEADLESS_AGENT_RESUME=0', async () => {
    vi.stubEnv('ORCA_HEADLESS_AGENT_RESUME', '0')
    try {
      const { runtime, spawn } = makeRuntime({ rows: [claudeRow()] })
      await openPane(runtime)
      expect(spawn.mock.calls[0][0].command).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('starts one agent when the same pane is opened twice at once', async () => {
    const { runtime, spawn } = makeRuntime({ rows: [claudeRow()] })

    await Promise.all([openPane(runtime), openPane(runtime)])

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0].resumeProviderSession).toEqual({
      key: 'session_id',
      id: 'session-row'
    })
  })

  it('opens a plain shell and says the agent could not resume when its session is not usable here', async () => {
    const { runtime, spawn } = makeRuntime({
      session: {
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'host-tab',
              ptyId: 'persisted-pty',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Claude',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              launchAgent: 'claude'
            }
          ]
        },
        sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepRecord({ connectionId: 'other-box' }) }
      }
    })

    const opened = await openPane(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0].command).toBeUndefined()
    expect(opened.tabs[0]).toMatchObject({
      agentResume: { agent: 'claude', outcome: 'unavailable' }
    })
  })

  it('publishes the resume on the pane until its agent reports again', async () => {
    const { runtime } = makeRuntime({ rows: [claudeRow()] })

    const opened = await openPane(runtime)
    expect(opened.tabs[0]).toMatchObject({ agentResume: { agent: 'claude', outcome: 'resumed' } })

    runtime.noteHeadlessAgentStatus(PANE_KEY)
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs[0]).not.toHaveProperty('agentResume')
  })

  it('leaves records and resume to the renderer while a window owns the session', async () => {
    const { runtime, getSession } = makeRuntime({
      rows: [claudeRow()],
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepRecord() } }
    })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)

    runtime.syncHeadlessAgentResumeAnchors()

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { id: 'session-slept' }
    })
  })

  it('sleeps a worktree with no renderer: records each agent, then stops its terminals', async () => {
    const { runtime, getSession } = makeRuntime({ rows: [claudeRow()] })
    runtime.registerPty('live-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    const sleep = vi.spyOn(runtime, 'sleepTerminalsForWorktree').mockResolvedValue({
      stopped: 1,
      stoppedPtyIds: ['live-pty'],
      livePtyIds: ['live-pty'],
      postStopVerified: true
    })

    await runtime.sleepManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { id: 'session-row' },
      restoreOnTabOpenOnly: true,
      interrupted: false
    })
    expect(sleep).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`)
  })
})
