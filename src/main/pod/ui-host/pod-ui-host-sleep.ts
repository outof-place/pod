// Fork-only (Pod): Close Terminals in the one-app runtime's window. The renderer stops only the PTYs
// its mounted panes bound; PodNative's terminals belong to the runtime and stay unbound in a window
// that shows another worktree (or none), so the runtime sleeps what is left. Its sleep also holds
// the worktree asleep, as a headless runtime's does (pod-ui-host-sleep-hold.ts).
import { ipcMain } from 'electron'
import { POD_UI_HOST_SLEEP_IPC } from '../../../shared/pod-ui-host-sleep'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { isPodUiHostLaunch } from './pod-ui-host-launch'
import { podUiHostLog } from './pod-ui-host-log'
import { beginPodUiHostWindowSleep, endPodUiHostWindowSleep } from './pod-ui-host-sleep-hold'

type SleepRuntime = Pick<
  OrcaRuntimeService,
  'sleepTerminalsForWorktree' | 'touchMobileSessionTabsForWorktree'
>

function isWorktreeId(worktreeId: unknown): worktreeId is string {
  return typeof worktreeId === 'string' && worktreeId !== ''
}

export async function sleepPodUiHostRuntimeTerminals(
  runtime: SleepRuntime,
  worktreeId: unknown,
  oneApp: boolean = isPodUiHostLaunch()
): Promise<void> {
  if (!oneApp || !isWorktreeId(worktreeId)) {
    return
  }
  const startedAt = Date.now()
  try {
    const slept = await runtime.sleepTerminalsForWorktree(`id:${worktreeId}`)
    podUiHostLog(
      `ui-host: Close Terminals in the window: the runtime slept ${slept.stopped} more in ${Date.now() - startedAt} ms`
    )
  } catch (error) {
    podUiHostLog(
      `ui-host: Close Terminals in the window: the runtime's sleep failed: ${String(error)}`
    )
    throw error
  } finally {
    endPodUiHostWindowSleep(worktreeId)
    // Why: one frame once the window's sleep is done, whichever order its exits landed in.
    runtime.touchMobileSessionTabsForWorktree(worktreeId, { immediate: true })
  }
}

export function installPodUiHostSleep(runtime: SleepRuntime): void {
  // Why always: the renderer can't tell a one-app runtime; elsewhere the handlers do nothing.
  ipcMain.on(POD_UI_HOST_SLEEP_IPC.begin, (_event, worktreeId: unknown) => {
    if (isPodUiHostLaunch() && isWorktreeId(worktreeId)) {
      podUiHostLog('ui-host: Close Terminals in the window: the worktree goes to sleep')
      beginPodUiHostWindowSleep(worktreeId)
    }
  })
  ipcMain.handle(POD_UI_HOST_SLEEP_IPC.runtimeTerminals, (_event, worktreeId: unknown) =>
    sleepPodUiHostRuntimeTerminals(runtime, worktreeId)
  )
}
