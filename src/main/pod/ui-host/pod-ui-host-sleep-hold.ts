// Fork-only (Pod): a worktree the one-app runtime's window is putting to sleep stays asleep. Its
// tabs go pending as the renderer stops their PTYs, and PodNative wakes a shown pending tab with an
// automatic activation; with a window that activation focuses the renderer's tab, whose spawn wakes
// the worktree again (a headless runtime refuses it). Electron-free: the runtime imports it.
import { isPodUiHostLaunch } from './pod-ui-host-launch'

// Why a bound: a renderer that never finishes its sleep (a teardown that throws) holds no worktree.
const WINDOW_SLEEP_IN_FLIGHT_MS = 30_000

const windowSleepStartedAt = new Map<string, number>()
// PTYs a worktree got while its window sleep was under way: a tab the user showed meanwhile.
const windowSleepSpawns = new Map<string, Set<string>>()

export function beginPodUiHostWindowSleep(worktreeId: string, now: number = Date.now()): void {
  windowSleepStartedAt.set(worktreeId, now)
  windowSleepSpawns.set(worktreeId, new Set())
}

export function endPodUiHostWindowSleep(worktreeId: string): void {
  windowSleepStartedAt.delete(worktreeId)
  windowSleepSpawns.delete(worktreeId)
}

function windowSleepInFlight(worktreeId: string, now: number): boolean {
  const startedAt = windowSleepStartedAt.get(worktreeId)
  return startedAt !== undefined && now - startedAt < WINDOW_SLEEP_IN_FLIGHT_MS
}

/** A PTY registered (runtime.registerPty): one the window's sleep must not stop at its end. */
export function notePodUiHostWindowSleepSpawn(
  worktreeId: string,
  ptyId: string,
  now: number = Date.now()
): void {
  if (windowSleepInFlight(worktreeId, now)) {
    windowSleepSpawns.get(worktreeId)?.add(ptyId)
  }
}

/** What the window's sleep spares: the PTYs its worktree got since it began, and gets until it
 *  ends. Live, not a copy: a tab shown while the runtime's part reads the process table counts. */
export function podUiHostWindowSleepSpawns(worktreeId: string): ReadonlySet<string> {
  return windowSleepSpawns.get(worktreeId) ?? new Set()
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
  return oneApp && windowSleepInFlight(worktreeId, now)
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
