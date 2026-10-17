import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  forgetPodRetainedPaneResume,
  setPodRendererRetainedExitNotice,
  type PodRetainedPaneResumeHost
} from './pod-terminal-exit-resume'

afterEach(() => setPodRendererRetainedExitNotice(null))

const surface = { worktreeId: 'wt', parentTabId: 'tab', leafId: 'left' }

function host(window: unknown, agentLaunchPane?: { leafId: string }) {
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId: 'wt',
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'claude',
          ...(agentLaunchPane ? { agentLaunchPane } : {})
        }
      ]
    }
  }
  const fake: PodRetainedPaneResumeHost = {
    getAvailableAuthoritativeWindow: () => window,
    forgetAgentResumeForPane: vi.fn(),
    getWorkspaceSessionForWorktree: () => session,
    setWorkspaceSessionForWorktree: (_worktreeId, next) => {
      session = next
    }
  }
  return { fake, tab: () => session.tabsByWorktree.wt?.[0] }
}

describe('a kept failed pane never resumes its agent (Pod)', () => {
  it("drops the pane's resume and, with no window, the tab's launch agent", () => {
    const { fake, tab } = host(null)
    forgetPodRetainedPaneResume(fake, surface)
    expect(fake.forgetAgentResumeForPane).toHaveBeenCalledWith('wt', 'tab:left')
    expect(tab()).not.toHaveProperty('launchAgent')
  })

  it("keeps the launch agent of a launch laid out in another of the tab's panes", () => {
    const { fake, tab } = host(null, { leafId: 'right' })
    forgetPodRetainedPaneResume(fake, surface)
    expect(tab()?.launchAgent).toBe('claude')
  })

  it('leaves the records to the window, which keeps them, and tells it', () => {
    const notice = vi.fn()
    setPodRendererRetainedExitNotice(notice)
    const window = { id: 1 }
    const { fake, tab } = host(window)
    forgetPodRetainedPaneResume(fake, surface)
    expect(notice).toHaveBeenCalledWith(window, { worktreeId: 'wt', tabId: 'tab', leafId: 'left' })
    expect(tab()?.launchAgent).toBe('claude')
  })
})
