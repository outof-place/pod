// Fork-only (Pod): startup work the Pod build profile defers or skips (src/shared/product/features.ts).
import {
  POD_STARTUP_BROWSER_SWEEP,
  POD_STARTUP_HANG_WATCHDOG,
  POD_TCC_PROMPT_WATCH
} from '../../shared/product/features'
import { runAfterFirstWindowShown } from './first-window-deferral'

const DEFERRED_HANG_WATCHDOG_FALLBACK_MS = 15_000

let startupSettled = false

// Returns true when the Pod profile holds the install until the first window is shown; the held
// install re-enters once startup has settled and then runs.
export function deferMainThreadHangWatchdog(install: () => unknown): boolean {
  if (POD_STARTUP_HANG_WATCHDOG || startupSettled) {
    return false
  }
  // Why: the previous run's hang marker is still read at startup; only the 2 s heartbeat waits.
  runAfterFirstWindowShown(() => {
    startupSettled = true
    install()
  }, DEFERRED_HANG_WATCHDOG_FALLBACK_MS)
  return true
}

export function startTccPromptNotice(init: () => void): void {
  if (POD_TCC_PROMPT_WATCH) {
    init()
  }
}

type AgentBrowserOrphanSweeper = { sweepOrphanedSessions(): Promise<unknown> }

export function sweepAgentBrowserOrphansAtStartup(bridge: AgentBrowserOrphanSweeper): void {
  if (POD_STARTUP_BROWSER_SWEEP) {
    void bridge.sweepOrphanedSessions()
  }
}

let firstUseSweep: Promise<unknown> | null = null

// Why fire and forget: the sweep only closes orca-tab sessions that are not live or pending, and
// orphans also exit on agent-browser's own idle timeout.
export function sweepAgentBrowserOrphansOnFirstUse(bridge: AgentBrowserOrphanSweeper): void {
  if (POD_STARTUP_BROWSER_SWEEP || firstUseSweep) {
    return
  }
  firstUseSweep = bridge.sweepOrphanedSessions().catch(() => [])
}
