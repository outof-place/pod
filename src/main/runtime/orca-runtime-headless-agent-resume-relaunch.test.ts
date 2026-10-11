// Across a host restart with no renderer: a pane whose agent can resume says so until its tab is
// shown, an agent that outlived the restart keeps its last state marked as from before it, and a
// ⌘⇧N agent that left no session comes back as a new one the client can announce.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { TabActivationIntent } from '../../shared/tab-activation-intent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = makePaneKey('host-tab', HEADLESS_LEAF_ID)
// Why the worktree prefix: the runtime places a spawned PTY in its worktree by this id.
const LIVE_PTY_ID = `${TEST_WORKTREE_ID}@@persisted-pty`

function hostTab(overrides: { launchAgent?: 'claude' } = {}) {
  return {
    id: 'host-tab',
    ptyId: LIVE_PTY_ID,
    worktreeId: TEST_WORKTREE_ID,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function claudeRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    state: 'waiting',
    prompt: 'fix the bug',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-row' },
    receivedAt: 1,
    stateStartedAt: 1,
    ...overrides
  }
}

function liveAnchor(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-lost' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    origin: 'live',
    ...overrides
  }
}

function makeRuntime(opts: {
  rows?: AgentStatusIpcPayload[]
  session?: Partial<WorkspaceSessionState>
}) {
  let rows = opts.rows ?? []
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: { [TEST_WORKTREE_ID]: [hostTab()] },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: LIVE_PTY_ID })
      },
      ...opts.session
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getAgentProviderSessionRowsForPane: (paneKey) => rows.filter((row) => row.paneKey === paneKey),
    getAgentProviderSessionSnapshot: () => rows
  })
  const spawn = vi.fn().mockResolvedValue({ id: LIVE_PTY_ID })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => false,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const setRows = (next: AgentStatusIpcPayload[]): void => {
    rows = next
  }
  return { runtime, spawn, setRows }
}

function openPane(runtime: InstanceType<typeof OrcaRuntimeService>, intent: TabActivationIntent) {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent
  })
}

async function listedPane(runtime: InstanceType<typeof OrcaRuntimeService>) {
  return (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs[0]
}

describe('headless agent resume across a host restart', () => {
  it('lists a lost agent as waiting to resume, with the state it was in', async () => {
    const { runtime } = makeRuntime({
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: liveAnchor() } }
    })

    expect(await listedPane(runtime)).toMatchObject({
      status: 'pending-handle',
      agentResume: { agent: 'claude', outcome: 'pending', stateBeforeRestart: 'working' }
    })
  })

  it('resumes only when the tab is shown, then says it did', async () => {
    const { runtime, spawn } = makeRuntime({
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: liveAnchor() } }
    })

    expect(await listedPane(runtime)).toMatchObject({ agentResume: { outcome: 'pending' } })
    expect(spawn).not.toHaveBeenCalled()

    const opened = await openPane(runtime, 'user')
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0].command).toMatch(/'--resume' 'session-lost'$/)
    expect(opened.tabs[0]).toMatchObject({ agentResume: { agent: 'claude', outcome: 'resumed' } })
  })

  it("ignores a record another worktree left under the pane's key", async () => {
    const { runtime } = makeRuntime({
      session: {
        sleepingAgentSessionsByPaneKey: {
          [PANE_KEY]: liveAnchor({ worktreeId: 'other-repo::/other' })
        }
      }
    })

    expect(await listedPane(runtime)).not.toHaveProperty('agentResume')
  })

  it('says a ⌘⇧N agent that left no session started over', async () => {
    const { runtime, spawn } = makeRuntime({
      session: { tabsByWorktree: { [TEST_WORKTREE_ID]: [hostTab({ launchAgent: 'claude' })] } }
    })

    const opened = await openPane(runtime, 'user')

    expect(spawn.mock.calls[0][0].command).toMatch(/^claude/)
    expect(spawn.mock.calls[0][0].resumeProviderSession).toBeUndefined()
    expect(opened.tabs[0]).toMatchObject({ agentResume: { agent: 'claude', outcome: 'restarted' } })
  })

  it('marks the state of an agent that outlived the restart until it speaks again', async () => {
    // The daemon kept the pane's terminal: it is live, and its row was hydrated from disk.
    const { runtime, setRows } = makeRuntime({})
    await openPane(runtime, 'user')
    setRows([claudeRow({ restoredUnconfirmed: true })])

    expect(await listedPane(runtime)).toMatchObject({
      status: 'ready',
      agentResume: { agent: 'claude', outcome: 'kept', stateBeforeRestart: 'waiting' }
    })

    setRows([claudeRow()])
    runtime.noteHeadlessAgentStatus(PANE_KEY)
    expect(await listedPane(runtime)).not.toHaveProperty('agentResume')
  })

  it("checks a kept agent's old state on its screen when the tab is shown", async () => {
    const { runtime, setRows } = makeRuntime({})
    await openPane(runtime, 'user')
    setRows([claudeRow({ restoredUnconfirmed: true })])
    // A dialog still owns the screen: the wait from before the restart holds.
    runtime.onPtyData(LIVE_PTY_ID, 'Do you trust the files in this folder?\r\n1. Yes\r\n2. No', 1)

    await openPane(runtime, 'automatic')

    await vi.waitFor(async () =>
      expect(await listedPane(runtime)).toMatchObject({
        agentResume: { outcome: 'kept', stateBeforeRestart: 'waiting', confirmed: true }
      })
    )
  })

  it("retires a kept agent's old state when its screen shows it ready", async () => {
    const { runtime, setRows } = makeRuntime({})
    await openPane(runtime, 'user')
    setRows([claudeRow({ restoredUnconfirmed: true, state: 'working' })])
    runtime.onPtyData(LIVE_PTY_ID, 'cursor agent\r\n→', 1)

    await openPane(runtime, 'user')

    await vi.waitFor(async () =>
      expect(await listedPane(runtime)).not.toHaveProperty('agentResume')
    )
  })

  it('shows nothing of the sort while a window owns the session', async () => {
    const { runtime } = makeRuntime({
      session: { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: liveAnchor() } }
    })
    expect(
      runtime.getPaneAgentResume(PANE_KEY, { worktreeId: TEST_WORKTREE_ID, pending: true })
    ).toMatchObject({ outcome: 'pending' })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    })
    runtime.attachWindow(1)

    expect(
      runtime.getPaneAgentResume(PANE_KEY, { worktreeId: TEST_WORKTREE_ID, pending: true })
    ).toBeUndefined()
  })
})
