// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'

let pod = true
const openedBeforeClaudeAccounts = vi.fn(async () => true)
const TAB = 'tab-1'
const LEAF = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'

vi.mock('../settings/pod-claude-acc-accounts-section', () => ({
  isPodClaudeAccAccounts: () => pod
}))
vi.mock('@/store', () => {
  const state = (): Record<string, unknown> => ({
    // A selection left from before claude-acc owned the accounts, with Claude running in the pane.
    settings: {
      claudeManagedAccounts: [{ id: 'p1' }],
      activeClaudeManagedAccountId: 'p1',
      activeClaudeManagedAccountIdsByRuntime: { host: 'p1', wsl: {} }
    },
    paneForegroundAgentByPaneKey: { [makePaneKey(TAB, LEAF)]: { agent: 'claude' } },
    agentStatusByPaneKey: {},
    unifiedTabsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        { contentType: 'terminal', entityId: TAB, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
      ]
    },
    allWorktrees: () => []
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

async function renderBanner(): Promise<void> {
  const { ClaudeOldTerminalBanner } = await import('./ClaudeOldTerminalBanner')
  render(React.createElement(ClaudeOldTerminalBanner, { ptyId: 'pty-1', tabId: TAB, leafId: LEAF }))
}

describe("Pod's old-terminal Claude banner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { pty: { openedBeforeClaudeAccounts } } })
  })

  afterEach(() => {
    cleanup()
  })

  it('never shows in Pod: claude-acc switches the login every terminal uses', async () => {
    pod = true
    await renderBanner()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openedBeforeClaudeAccounts).not.toHaveBeenCalled()
  })

  it('still asks about the pane outside Pod', async () => {
    pod = false
    await renderBanner()
    await waitFor(() =>
      expect(openedBeforeClaudeAccounts).toHaveBeenCalledWith('pty-1', { runtime: 'host' })
    )
  })
})
