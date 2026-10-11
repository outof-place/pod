// Fork-only (Pod): restarting OrbStack, the user's one fix for a machine network that stopped
// handing out addresses. It stops every running container and machine on the Mac, not only Pod's;
// clients ask before they call it.
import type { PodOrbstackActionResult } from '../../../shared/pod-orbstack-types'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

const STOP_MS = 2 * 60_000
const START_MS = 3 * 60_000

function detail(result: OrbstackToolResult): string {
  return result.timedOut ? 'timed out' : result.stderr.trim().split('\n').at(-1) || 'failed'
}

export async function restartPodOrbstack(deps: {
  run: OrbstackToolRunner
  /** Worktrees with a create, delete or start in flight: a restart would cut it off. */
  busyWorktreeIds: () => readonly string[]
  /** Before the stop: Pod's own `orb` children (stats readers) end with the VM anyway. */
  beforeStop?: () => void
  env?: NodeJS.ProcessEnv
}): Promise<PodOrbstackActionResult> {
  // Why: an E2E profile still drives the user's one real OrbStack; no test may restart it.
  if ((deps.env ?? process.env).ORCA_E2E_USER_DATA_DIR) {
    return { ok: false, error: 'Pod does not restart OrbStack from a test profile.' }
  }
  if (deps.busyWorktreeIds().length > 0) {
    return {
      ok: false,
      error: 'Wait until Pod finishes changing a machine, then restart OrbStack.'
    }
  }
  deps.beforeStop?.()
  const stopped = await deps.run('orbctl', ['stop'], { timeoutMs: STOP_MS })
  if (stopped.code !== 0) {
    return { ok: false, error: `orbctl stop: ${detail(stopped)}` }
  }
  const started = await deps.run('orbctl', ['start'], { timeoutMs: START_MS })
  if (started.code !== 0) {
    return { ok: false, error: `orbctl start: ${detail(started)}` }
  }
  return { ok: true }
}
