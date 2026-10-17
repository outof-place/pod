// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { PodUiHostPaneLayoutRequest } from '../../../../shared/pod-ui-host-pane-layout'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import type { PaneManager as PaneManagerType } from '@/lib/pane-manager/pane-manager'
import type { PaneManagerOptions } from '@/lib/pane-manager/pane-manager-types'

// Why: happy-dom has no canvas, so xterm cannot open; the layout never touches the terminal.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('@/lib/pane-manager/pane-manager')
const { applyPodPaneLayoutToMountedTab, applyPodPaneLayoutToStoredLayout } =
  await import('./pod-terminal-pane-layout-apply')

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (ratio?: number): TerminalPaneLayoutNode => ({
  type: 'split',
  direction: 'vertical',
  first: leaf(LEFT),
  second: leaf(RIGHT),
  ...(ratio !== undefined ? { ratio } : {})
})
const request = (over: Partial<PodUiHostPaneLayoutRequest>): PodUiHostPaneLayoutRequest => ({
  worktreeId: 'wt',
  tabId: 'tab',
  root: null,
  expandedLeafId: null,
  ...over
})

describe('applyPodPaneLayoutToMountedTab (Pod)', () => {
  let root: HTMLDivElement
  let manager: PaneManagerType
  let onActivePaneChange: Mock<NonNullable<PaneManagerOptions['onActivePaneChange']>>
  let target: Parameters<typeof applyPodPaneLayoutToMountedTab>[0]
  let paneIds: { left: number; right: number }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onActivePaneChange = vi.fn()
    manager = new PaneManager(root, { linkOpenHint: () => '', onActivePaneChange })
    const left = manager.createInitialPane({ leafId: LEFT, focus: false })
    const right = manager.splitPane(left.id, 'vertical', { leafId: RIGHT })
    manager.setActivePane(left.id, { focus: false })
    paneIds = { left: left.id, right: right!.id }
    onActivePaneChange.mockClear()
    const expandedPaneIdRef: { current: number | null } = { current: null }
    target = {
      managerRef: { current: manager },
      containerRef: { current: root },
      expandedPaneIdRef,
      expandedStyleSnapshotRef: { current: new Map() },
      ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' },
      setExpandedPane: vi.fn((paneId: number | null) => {
        expandedPaneIdRef.current = paneId
      }),
      refreshPaneSizes: vi.fn(),
      persistLayoutSnapshot: vi.fn()
    }
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  const serialized = () =>
    root.firstElementChild instanceof HTMLElement ? serializePaneTree(root.firstElementChild) : null

  it('moves the split and the active pane in place, focuses nothing, and persists', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const terminalFocus = manager.getPanes().map((pane) => vi.spyOn(pane.terminal, 'focus'))

    expect(
      applyPodPaneLayoutToMountedTab(target, request({ root: split(0.3), activeLeafId: RIGHT }))
    ).toEqual({ applied: true })

    expect(serialized()).toEqual(split(0.3))
    expect(manager.getActivePane()?.id).toBe(paneIds.right)
    expect(onActivePaneChange).toHaveBeenCalledTimes(1)
    expect(target.refreshPaneSizes).toHaveBeenCalledWith(false)
    expect(target.persistLayoutSnapshot).toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    for (const spy of terminalFocus) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('expands a pane, keeps the split under it, and collapses back to that split', () => {
    applyPodPaneLayoutToMountedTab(target, request({ root: split(0.3), expandedLeafId: RIGHT }))
    expect(target.setExpandedPane).toHaveBeenLastCalledWith(paneIds.right)
    expect(
      manager.getPanes().find((pane) => pane.id === paneIds.left)?.container.style.display
    ).toBe('none')

    expect(applyPodPaneLayoutToMountedTab(target, request({ root: split(0.4) }))).toEqual({
      applied: true
    })
    expect(target.setExpandedPane).toHaveBeenLastCalledWith(null)
    expect(serialized()).toEqual(split(0.4))
  })

  it('refuses another set of panes, an unknown leaf and an unbound active pane, changing nothing', () => {
    const before = serialized()
    const other = { type: 'leaf' as const, leafId: '33333333-3333-4333-8333-333333333333' }
    expect(applyPodPaneLayoutToMountedTab(target, request({ root: other }))).toEqual({
      applied: false,
      reason: 'layout_mismatch'
    })
    expect(
      applyPodPaneLayoutToMountedTab(target, request({ expandedLeafId: other.leafId }))
    ).toEqual({ applied: false, reason: 'leaf_not_found' })
    target.ptyIdsByLeafId = { [LEFT]: 'pty-left' }
    expect(applyPodPaneLayoutToMountedTab(target, request({ activeLeafId: RIGHT }))).toEqual({
      applied: false,
      reason: 'active_leaf_not_ready'
    })
    expect(serialized()).toEqual(before)
    expect(manager.getActivePane()?.id).toBe(paneIds.left)
    expect(target.persistLayoutSnapshot).not.toHaveBeenCalled()
  })
})

describe('applyPodPaneLayoutToStoredLayout (Pod)', () => {
  const stored: TerminalLayoutSnapshot = {
    root: split(),
    activeLeafId: LEFT,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
  }

  it("writes the layout an unmounted tab's mount replays", () => {
    expect(
      applyPodPaneLayoutToStoredLayout(
        stored,
        request({ root: split(0.3), expandedLeafId: RIGHT, activeLeafId: RIGHT })
      )
    ).toEqual({
      reply: { applied: true },
      layout: { ...stored, root: split(0.3), expandedLeafId: RIGHT, activeLeafId: RIGHT }
    })
  })

  it('keeps the splits and the active pane a request leaves out', () => {
    expect(applyPodPaneLayoutToStoredLayout(stored, request({})).layout).toEqual(stored)
  })

  it('refuses a tab it has no layout for, and leaves it has not', () => {
    expect(applyPodPaneLayoutToStoredLayout(undefined, request({})).reply).toEqual({
      applied: false,
      reason: 'tab_not_found'
    })
    expect(
      applyPodPaneLayoutToStoredLayout(stored, request({ activeLeafId: 'gone' })).reply
    ).toEqual({ applied: false, reason: 'leaf_not_found' })
  })
})
