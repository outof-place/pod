import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import {
  beginPodUiHostWindowSleep,
  endPodUiHostWindowSleep
} from '../../pod/ui-host/pod-ui-host-sleep-hold'

// Fork-only (Pod): the one-app runtime, whatever the test process's argv says.
vi.mock('../../pod/ui-host/pod-ui-host-launch', () => ({ isPodUiHostLaunch: () => true }))

const LEAF = '77777777-7777-4777-8777-777777777777'

async function makeWindowedRuntime() {
  let nextPty = 0
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockImplementation(async () => ({ id: `window-pty-${++nextPty}` })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { tabId: 'tab-a', leafId: LEAF })
  const focusTerminal = vi.fn()
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal,
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.markGraphReady(1)
  electronMocks.BrowserWindow.fromId.mockReturnValue({
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
  return { runtime, focusTerminal }
}

describe('one-app window: Close Terminals holds the worktree asleep', () => {
  afterEach(() => endPodUiHostWindowSleep(TEST_WORKTREE_ID))

  it("leaves a sleeping worktree's tab unfocused for an automatic activation", async () => {
    const { runtime, focusTerminal } = await makeWindowedRuntime()
    beginPodUiHostWindowSleep(TEST_WORKTREE_ID)

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-a', LEAF, {
      intent: 'automatic'
    })

    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('still focuses it for the user, which is the wake', async () => {
    const { runtime, focusTerminal } = await makeWindowedRuntime()
    beginPodUiHostWindowSleep(TEST_WORKTREE_ID)

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-a', LEAF, {
      intent: 'user'
    })

    expect(focusTerminal).toHaveBeenCalledWith('tab-a', TEST_WORKTREE_ID, LEAF)
  })

  it('focuses it for an automatic activation once the worktree is awake', async () => {
    const { runtime, focusTerminal } = await makeWindowedRuntime()

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-a', LEAF, {
      intent: 'automatic'
    })

    expect(focusTerminal).toHaveBeenCalledWith('tab-a', TEST_WORKTREE_ID, LEAF)
  })
})
