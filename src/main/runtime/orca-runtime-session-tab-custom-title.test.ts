import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeMobileSessionClientTab } from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  recordPodTerminalExit,
  resetPodTerminalExitsForTests
} from '../pod/terminal-exit/pod-terminal-exits'

const POD_CUSTOM_TITLE = 'pod.session-tabs.custom-title.v1'

type TerminalClientTab = Extract<RuntimeMobileSessionClientTab, { type: 'terminal' }>

function terminalsOf(
  tabs: RuntimeMobileSessionClientTab[],
  parentTabId: string
): TerminalClientTab[] {
  return tabs.filter(
    (tab): tab is TerminalClientTab => tab.type === 'terminal' && tab.parentTabId === parentTabId
  )
}

function headlessRuntime(session = makeWorkspaceSessionWithHeadlessTerminal()) {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  return { runtime, getSession }
}

function ptyController() {
  let spawned = 0
  return {
    spawn: vi.fn(async () => ({ id: `named-pty-${++spawned}` })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
}

async function listedSurfaces(
  runtime: InstanceType<typeof OrcaRuntimeService>,
  parentTabId = 'host-tab'
): Promise<TerminalClientTab[]> {
  return terminalsOf(
    (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs,
    parentTabId
  )
}

afterEach(() => {
  resetPodTerminalExitsForTests()
})

describe('a terminal tab name on session tabs (customTitle)', () => {
  it('is advertised, so a client tells an older host from a tab with no name', () => {
    const { runtime } = headlessRuntime()

    expect(runtime.getStatus().capabilities).toContain(POD_CUSTOM_TITLE)
  })

  it('publishes a stored name on every leaf of a headless tab, and none for a tab without one', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const [hostTab] = session.tabsByWorktree[TEST_WORKTREE_ID]!
    // A session written before tabs had names at all carries no key.
    const oldTab = { ...hostTab!, id: 'old-tab', ptyId: null, sortOrder: 2 }
    Reflect.deleteProperty(oldTab, 'customTitle')
    session.tabsByWorktree[TEST_WORKTREE_ID] = [
      { ...hostTab!, customTitle: '  Auth refactor ' },
      { ...hostTab!, id: 'plain-tab', ptyId: null, customTitle: null, sortOrder: 1 },
      oldTab
    ]
    session.terminalLayoutsByTabId['host-tab'] = makeHeadlessTerminalLayout({
      [HEADLESS_LEAF_ID]: 'persisted-pty',
      [HEADLESS_SECOND_LEAF_ID]: undefined
    })
    const { runtime } = headlessRuntime(session)

    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const { tabs } = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    const named = terminalsOf(tabs, 'host-tab')
    expect(named.map((tab) => tab.leafId)).toEqual([HEADLESS_LEAF_ID, HEADLESS_SECOND_LEAF_ID])
    expect(named.map((tab) => tab.customTitle)).toEqual(['Auth refactor', 'Auth refactor'])
    for (const id of ['plain-tab', 'old-tab']) {
      const [tab] = terminalsOf(tabs, id)
      expect(tab).toBeDefined()
      expect(tab).not.toHaveProperty('customTitle')
    }
  })

  it('follows a headless rename at once, and goes on a clear', async () => {
    const { runtime } = headlessRuntime()
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'named-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    const surface = async () =>
      terminalsOf(
        (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs,
        'host-tab'
      )[0]

    expect(await surface()).not.toHaveProperty('customTitle')

    await runtime.renameTerminal(created.handle, 'Auth refactor')
    expect(await surface()).toMatchObject({
      customTitle: 'Auth refactor',
      title: 'Auth refactor'
    })

    await runtime.renameTerminal(created.handle, null)
    expect(await surface()).not.toHaveProperty('customTitle')
  })

  it('keeps the name on a headless split’s new pane, so it outlasts the pane it came from', async () => {
    const { runtime } = headlessRuntime()
    let spawned = 0
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: `split-pty-${++spawned}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    await runtime.renameTerminal(created.handle, 'Auth refactor')

    const split = await runtime.splitTerminal(created.handle, { direction: 'vertical' })

    const leaves = await listedSurfaces(runtime)
    expect(leaves).toHaveLength(2)
    expect(leaves.map((tab) => tab.customTitle)).toEqual(['Auth refactor', 'Auth refactor'])

    await runtime.closeTerminal(created.handle)

    const [left, ...rest] = await listedSurfaces(runtime)
    expect(rest).toHaveLength(0)
    expect(left).toMatchObject({ terminal: split.handle, customTitle: 'Auth refactor' })
  })

  it('keeps the name when a pane of a named tab restarts on a host with no window', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const [hostTab] = session.tabsByWorktree[TEST_WORKTREE_ID]!
    session.tabsByWorktree[TEST_WORKTREE_ID] = [{ ...hostTab!, customTitle: 'Auth refactor' }]
    const { runtime } = headlessRuntime(session)
    runtime.setPtyController(ptyController())
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    expect((await listedSurfaces(runtime))[0]).toMatchObject({ customTitle: 'Auth refactor' })
    recordPodTerminalExit(
      { worktreeId: TEST_WORKTREE_ID, parentTabId: 'host-tab', leafId: HEADLESS_LEAF_ID },
      { exitCode: 1, exitedAt: 1_000 }
    )

    const { terminal } = await runtime.restartExitedMobileSessionTerminal(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID
    )

    const surfaces = await listedSurfaces(runtime)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({ terminal, customTitle: 'Auth refactor' })
  })

  it('keeps the name when a restored agent pane resumes its session on a host with no window', async () => {
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-lost' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          connectionId: null,
          origin: 'live'
        }
      }
    })
    const [hostTab] = session.tabsByWorktree[TEST_WORKTREE_ID]!
    session.tabsByWorktree[TEST_WORKTREE_ID] = [{ ...hostTab!, customTitle: 'Auth refactor' }]
    const { runtime } = headlessRuntime(session)
    const controller = ptyController()
    runtime.setPtyController({
      ...controller,
      // The woken pane re-enters its old session: that pty's exit retires the pane's surface while the new one spawns.
      spawn: vi.fn(async (...args: Parameters<typeof controller.spawn>) => {
        const stored = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!
        runtime['storeMobileSessionSnapshot'](TEST_WORKTREE_ID, {
          ...stored,
          tabs: stored.tabs.filter(
            (tab) => tab.type !== 'terminal' || tab.parentTabId !== 'host-tab'
          )
        })
        return controller.spawn(...args)
      })
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    expect((await listedSurfaces(runtime))[0]).toMatchObject({
      status: 'pending-handle',
      customTitle: 'Auth refactor'
    })

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })

    const surfaces = await listedSurfaces(runtime)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({ status: 'ready', customTitle: 'Auth refactor' })
  })

  it('follows a rename that reaches a window not yet holding its pane graph', async () => {
    const { runtime } = headlessRuntime()
    runtime.setPtyController(ptyController())
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    const renameTerminal = vi.fn()
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal,
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    await runtime.renameTerminal(created.handle, 'Auth refactor')

    expect(renameTerminal).toHaveBeenCalledWith('host-tab', 'Auth refactor')
    expect((await listedSurfaces(runtime))[0]).toMatchObject({ customTitle: 'Auth refactor' })
    await runtime.renameTerminal(created.handle, null)
    expect((await listedSurfaces(runtime))[0]).not.toHaveProperty('customTitle')
  })

  it('publishes a title the host applies to a new worktree’s tab as its name', async () => {
    const { runtime, getSession } = headlessRuntime()
    runtime.setPtyController(ptyController())
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    await runtime['getWorktreeTerminalProvisioningHost']().setTabTitle(created.handle, 'Setup')

    expect((await listedSurfaces(runtime))[0]).toMatchObject({
      customTitle: 'Setup',
      title: 'Setup'
    })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.customTitle).toBe('Setup')
  })

  it('passes a Pod-window publication’s name through to clients', async () => {
    const { runtime } = headlessRuntime()
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:names',
          snapshotVersion: 1,
          activeGroupId: 'group',
          activeTabId: 'window-tab::leaf',
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'group',
              activeTabId: 'window-tab',
              tabOrder: ['window-tab']
            }
          ],
          tabs: [
            {
              type: 'terminal',
              id: 'window-tab::leaf',
              parentTabId: 'window-tab',
              leafId: 'leaf',
              title: '✳ Fix login redirect',
              customTitle: 'Auth refactor',
              isActive: true
            }
          ]
        }
      ]
    })

    const [tab] = terminalsOf(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs,
      'window-tab'
    )
    expect(tab).toMatchObject({
      customTitle: 'Auth refactor',
      title: '✳ Fix login redirect'
    })
  })
})
