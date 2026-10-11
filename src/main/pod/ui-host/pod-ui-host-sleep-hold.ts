// Fork-only (Pod): a worktree the one-app runtime's window is putting to sleep stays asleep. Its
// tabs go pending as the renderer stops their PTYs, and PodNative wakes a shown pending tab with an
// automatic activation; with a window that activation focuses the renderer's tab, whose spawn wakes
// the worktree again (a headless runtime refuses it). Electron-free: the runtime imports it.
import { isPodUiHostLaunch } from './pod-ui-host-launch'

// Why a bound: a renderer that never finishes its sleep (a teardown that throws) holds no worktree.
const WINDOW_SLEEP_IN_FLIGHT_MS = 30_000

const windowSleepStartedAt = new Map<string, number>()

export function beginPodUiHostWindowSleep(worktreeId: string, now: number = Date.now()): void {
  windowSleepStartedAt.set(worktreeId, now)
}

export function endPodUiHostWindowSleep(worktreeId: string): void {
  windowSleepStartedAt.delete(worktreeId)
}

/** The runtime's own sleep hold, or the window's sleep still under way in a one-app runtime. */
export function podUiHostWorktreeSleepHeld(
  worktreeId: string,
  runtimeHeld: boolean,
  oneApp: boolean = isPodUiHostLaunch(),
  now: number = Date.now()
): boolean {
  if (runtimeHeld) {
    return true
  }
  const startedAt = windowSleepStartedAt.get(worktreeId)
  return oneApp && startedAt !== undefined && now - startedAt < WINDOW_SLEEP_IN_FLIGHT_MS
}

/** An automatic activation in a one-app runtime leaves a sleeping worktree's tab unfocused. */
export function podUiHostRefusesAutomaticFocus(
  automatic: boolean,
  worktreeId: string,
  runtimeHeld: boolean,
  oneApp: boolean = isPodUiHostLaunch(),
  now: number = Date.now()
): boolean {
  return automatic && oneApp && podUiHostWorktreeSleepHeld(worktreeId, runtimeHeld, oneApp, now)
}
