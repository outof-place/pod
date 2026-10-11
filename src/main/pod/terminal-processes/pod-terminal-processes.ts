// Fork-only (Pod): which process each local terminal runs, for a native client on this Mac that
// samples CPU and memory itself (PodNative's status bar). Pids only: Pod samples nothing for it,
// and nothing runs until a client asks.
import { getProductIdentity } from '../../product-identity/product-identity'
import type { PtyProcessInfo } from '../../providers/pty-process-info'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { PodTerminalProcess } from '../../../shared/pod-terminal-processes-types'

/** The PTY controller's inventory, as main installs it for the runtime. */
export type PodPtyProcessList = (
  hostId: ExecutionHostId,
  opts: { deadlineMs: number }
) => Promise<PtyProcessInfo[]>

// Why a bound budget: the daemon's listSessions answers in milliseconds; a stuck daemon must not
// hold a client's call open.
const LIST_BUDGET_MS = 2_000

let list: PodPtyProcessList | null = null

/** Main hands over the controller's inventory beside `setPtyController` (a no-op cost: a closure). */
export function registerPodTerminalProcesses(next: PodPtyProcessList | null): void {
  list = next
}

/**
 * On in a Pod build (its product identity); upstream Orca answers nothing.
 * `POD_TERMINAL_PROCESSES=0|1` overrides the identity, for tests.
 */
export function isPodTerminalProcessesEnabled(
  env: NodeJS.ProcessEnv = process.env,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (env.POD_TERMINAL_PROCESSES === '0') {
    return false
  }
  return env.POD_TERMINAL_PROCESSES === '1' || hasIdentity()
}

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    return false
  }
}

/** This Mac's terminals only: an SSH host's pids mean nothing to a client sampling here. */
export async function listPodTerminalProcesses(
  source: PodPtyProcessList | null = list,
  now: () => number = Date.now
): Promise<PodTerminalProcess[]> {
  if (!source) {
    throw new Error('Terminal processes are not available yet.')
  }
  const rows = await source(LOCAL_EXECUTION_HOST_ID, { deadlineMs: now() + LIST_BUDGET_MS })
  return rows.map((row) => ({
    ptyId: row.id,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.terminalHandle ? { handle: row.terminalHandle } : {}),
    ...(row.rootProcessId ? { shellPid: row.rootProcessId } : {})
  }))
}
