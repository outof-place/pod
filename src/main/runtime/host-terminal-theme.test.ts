import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileTerminalTheme
} from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import {
  setHostSystemPrefersDark,
  settingsUpdateTouchesTerminalTheme
} from './runtime-host-terminal-theme'
import { TERMINAL_VIEWER_COLORS_METHODS } from './rpc/methods/terminal/terminal-viewer-colors-method'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewerColors
} from './terminal-view-attribute-store'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const RENDERER_THEME: RuntimeMobileTerminalTheme = {
  mode: 'dark',
  theme: { foreground: '#010101', background: '#020202' }
}

let settings: Record<string, unknown> = {}
const store = {
  getRepos: () => [],
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    ...settings
  }),
  updateSettings: () => {}
}

function makeRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getSettings and the repo and worktree lists from the store.
  return new OrcaRuntimeService(store as never)
}

type Private = { mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot> }

function seed(runtime: OrcaRuntimeService, terminalTheme?: RuntimeMobileTerminalTheme): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches the runtime's snapshot map, a protected field.
  ;(runtime as unknown as Private).mobileSessionTabsByWorktree.set('worktree-a', {
    worktree: 'worktree-a',
    publicationEpoch: 'headless:epoch',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'tab-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1',
        title: 'shell',
        parentTabId: 'group-1',
        leafId: 'leaf-1',
        isActive: true,
        ...(terminalTheme ? { terminalTheme } : {})
      }
    ]
  })
}

function terminalTheme(
  event: RuntimeMobileSessionTabsResult
): RuntimeMobileTerminalTheme | undefined {
  const tab = event.tabs[0]
  return tab?.type === 'terminal' ? tab.terminalTheme : undefined
}

describe('host terminal theme (headless)', () => {
  afterEach(() => {
    setHostSystemPrefersDark(() => true)
    _resetTerminalViewAttributesForTest()
    settings = {}
  })

  it('publishes the theme the settings resolve to, and again when they change', () => {
    settings = {
      theme: 'dark',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: ''
    }
    const runtime = makeRuntime()
    seed(runtime)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => events.push(event))

    runtime.refreshHostTerminalTheme()
    expect(events).toHaveLength(1)
    expect(terminalTheme(events[0])).toMatchObject({
      mode: 'dark',
      theme: { background: '#282c34', foreground: '#ffffff' }
    })

    // Nothing that reaches the theme moved: no event.
    runtime.refreshHostTerminalTheme()
    expect(events).toHaveLength(1)

    settings = { ...settings, theme: 'light', terminalColorOverrides: { background: '#fafafa' } }
    runtime.refreshHostTerminalTheme()
    expect(events).toHaveLength(2)
    expect(terminalTheme(events[1])).toMatchObject({
      mode: 'light',
      theme: { background: '#fafafa' }
    })
    unsubscribe()
  })

  it('follows the system appearance under the system theme', () => {
    settings = {
      theme: 'system',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: ''
    }
    let dark = true
    setHostSystemPrefersDark(() => dark)
    const runtime = makeRuntime()
    seed(runtime)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => events.push(event))
    runtime.refreshHostTerminalTheme()
    dark = false
    runtime.refreshHostTerminalTheme()
    expect(events.map((event) => terminalTheme(event)?.mode)).toEqual(['dark', 'light'])
    unsubscribe()
  })

  it("keeps a renderer's theme and doesn't republish its snapshot", () => {
    settings = {
      theme: 'light',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: ''
    }
    const runtime = makeRuntime()
    seed(runtime, RENDERER_THEME)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => events.push(event))
    runtime.refreshHostTerminalTheme()
    expect(events).toHaveLength(0)
    unsubscribe()
  })

  it("answers the host's theme again once the last viewer that reported colours disconnects", async () => {
    settings = {
      theme: 'light',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: ''
    }
    const runtime = makeRuntime()
    runtime.refreshHostTerminalTheme()
    const hostColors = getTerminalViewerColors()
    expect(hostColors?.background).not.toBe('#282c34')
    const [setViewerColors] = TERMINAL_VIEWER_COLORS_METHODS
    const first = { foreground: '#111111', background: '#222222' }
    await setViewerColors.handler({ colors: first }, { runtime, clientId: 'stream-a' })
    await setViewerColors.handler(
      { colors: { foreground: '#333333', background: '#444444' } },
      { runtime, clientId: 'stream-b' }
    )
    runtime.onClientDisconnected('stream-b')
    expect(getTerminalViewerColors()).toEqual(first)
    runtime.onClientDisconnected('stream-a')
    expect(getTerminalViewerColors()).toEqual(hostColors)
  })

  it('names the settings that move the theme', () => {
    expect(settingsUpdateTouchesTerminalTheme({ terminalThemeLight: 'x' })).toBe(true)
    expect(settingsUpdateTouchesTerminalTheme({ theme: 'dark' })).toBe(true)
    expect(settingsUpdateTouchesTerminalTheme({ terminalFontSize: 14 })).toBe(false)
  })
})
