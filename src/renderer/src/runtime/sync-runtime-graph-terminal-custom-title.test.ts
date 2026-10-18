import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

const firstLeaf = '11111111-1111-4111-8111-111111111111'
const secondLeaf = '22222222-2222-4222-8222-222222222222'

function splitTabState(customTitle: string | null | undefined): AppState {
  const tab: TerminalTab = {
    id: 'term-1',
    worktreeId: 'wt-1',
    ptyId: 'pty-1',
    title: '✳ Fix login redirect',
    defaultTitle: 'Terminal',
    customTitle: customTitle ?? null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  // A tab persisted before tabs had names carries no key at all.
  if (customTitle === undefined) {
    Reflect.deleteProperty(tab, 'customTitle')
  }
  const layout: TerminalLayoutSnapshot = {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: firstLeaf },
      second: { type: 'leaf', leafId: secondLeaf }
    },
    activeLeafId: secondLeaf,
    expandedLeafId: null,
    ptyIdsByLeafId: { [firstLeaf]: 'pty-left', [secondLeaf]: 'pty-right' },
    titlesByLeafId: { [firstLeaf]: 'zsh', [secondLeaf]: '✳ Fix login redirect' }
  }
  return makeState({
    tabsByWorktree: { 'wt-1': [tab] },
    terminalLayoutsByTabId: { 'term-1': layout }
  })
}

describe('a terminal tab name on Pod-window publications', () => {
  it('carries the name on every leaf, beside each leaf’s own live title', () => {
    const tabs = buildMobileSessionTabSnapshots(splitTabState('  Auth refactor '))[0]?.tabs

    expect(tabs).toMatchObject([
      { leafId: firstLeaf, customTitle: 'Auth refactor', title: 'zsh' },
      {
        leafId: secondLeaf,
        customTitle: 'Auth refactor',
        title: '✳ Fix login redirect'
      }
    ])
  })

  it.each([
    ['never named (an older session)', undefined],
    ['cleared', null],
    ['blank', '  ']
  ])('publishes no name when the tab is %s', (_case, customTitle) => {
    const tabs = buildMobileSessionTabSnapshots(splitTabState(customTitle))[0]?.tabs ?? []

    expect(tabs).toHaveLength(2)
    for (const tab of tabs) {
      expect(tab).not.toHaveProperty('customTitle')
    }
  })
})
