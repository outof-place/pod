import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
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

    await runtime.splitTerminal(created.handle, { direction: 'vertical' })

    const leaves = terminalsOf(
      (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs,
      'host-tab'
    )
    expect(leaves).toHaveLength(2)
    expect(leaves.map((tab) => tab.customTitle)).toEqual(['Auth refactor', 'Auth refactor'])
    // The host's own record of each pane, which outlives the first pane's close.
    const stored = runtime['mobileSessionTabsByWorktree'].get(TEST_WORKTREE_ID)!.tabs
    expect(stored.map((tab) => (tab.type === 'terminal' ? tab.customTitle : null))).toEqual([
      'Auth refactor',
      'Auth refactor'
    ])
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
