import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

import { sleepPodUiHostRuntimeTerminals } from './pod-ui-host-sleep'
import {
  beginPodUiHostWindowSleep,
  endPodUiHostWindowSleep,
  podUiHostWorktreeSleepHeld
} from './pod-ui-host-sleep-hold'

function runtime() {
  return {
    sleepTerminalsForWorktree: vi.fn().mockResolvedValue({ stopped: 0 }),
    touchMobileSessionTabsForWorktree: vi.fn()
  }
}

describe('sleepPodUiHostRuntimeTerminals', () => {
  afterEach(() => endPodUiHostWindowSleep('repo::/w'))

  it("sleeps the worktree's runtime PTYs in a one-app runtime, then ends the window's sleep", async () => {
    const host = runtime()
    beginPodUiHostWindowSleep('repo::/w')
    await sleepPodUiHostRuntimeTerminals(host, 'repo::/w', true)
    expect(host.sleepTerminalsForWorktree).toHaveBeenCalledWith('id:repo::/w')
    expect(host.touchMobileSessionTabsForWorktree).toHaveBeenCalledWith('repo::/w', {
      immediate: true
    })
    expect(podUiHostWorktreeSleepHeld('repo::/w', false, true)).toBe(false)
  })

  it("ends the window's sleep when the runtime's fails too", async () => {
    const host = {
      ...runtime(),
      sleepTerminalsForWorktree: vi.fn().mockRejectedValue(new Error('stop failed'))
    }
    beginPodUiHostWindowSleep('repo::/w')
    await expect(sleepPodUiHostRuntimeTerminals(host, 'repo::/w', true)).rejects.toThrow(
      'stop failed'
    )
    expect(podUiHostWorktreeSleepHeld('repo::/w', false, true)).toBe(false)
  })

  it('does nothing in any other launch, or for a request without a worktree', async () => {
    const host = runtime()
    await sleepPodUiHostRuntimeTerminals(host, 'repo::/w', false)
    await sleepPodUiHostRuntimeTerminals(host, 42, true)
    await sleepPodUiHostRuntimeTerminals(host, '', true)
    expect(host.sleepTerminalsForWorktree).not.toHaveBeenCalled()
    expect(host.touchMobileSessionTabsForWorktree).not.toHaveBeenCalled()
  })
})
