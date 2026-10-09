/**
 * Who holds one pane's terminal, from a `ps` limited to that terminal's processes: a few
 * milliseconds, where the whole-machine capture behind a fresh scan or an `inspectProcess`
 * observation takes seconds on a loaded host and gated every launch paste behind it.
 */

import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { runProcess } from '../../shared/child-process/run-process'
import { getNativeProcessInfo, type NativeProcessRow } from '../../shared/native-process-info'
import { parseShellForegroundRows, type ProcessTableRow } from '../../shared/process-table-snapshot'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'

const PS_TIMEOUT_MS = 3_000
const PS_MAX_OUTPUT_BYTES = 256 * 1024
/** Root pid to its terminal: a live process keeps its controlling terminal. */
const ttyByRootPid = new Map<number, string>()
const TTY_CACHE_LIMIT = 256

async function ps(args: readonly string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'ps',
      args,
      timeoutMs: PS_TIMEOUT_MS,
      maxOutputBytes: PS_MAX_OUTPUT_BYTES
    })
    return result.code === 0 ? result.stdout : null
  } catch {
    return null
  }
}

async function terminalOf(rootPid: number): Promise<string | null> {
  const cached = ttyByRootPid.get(rootPid)
  if (cached) {
    return cached
  }
  const native = readNativeProcess(rootPid)
  const tty = (
    native !== undefined ? native?.tty : await ps(['-o', 'tty=', '-p', String(rootPid)])
  )?.trim()
  // `??` (macOS) and `?` (Linux): no controlling terminal.
  if (!tty || tty.startsWith('?')) {
    return null
  }
  if (ttyByRootPid.size >= TTY_CACHE_LIMIT) {
    ttyByRootPid.clear()
  }
  ttyByRootPid.set(rootPid, tty)
  return tty
}

/** Undefined when the addon cannot answer, so `ps` does; null when the pid is gone. */
function readNativeProcess(pid: number): NativeProcessRow | null | undefined {
  try {
    return getNativeProcessInfo()?.readProcess(pid)
  } catch {
    return undefined
  }
}

/**
 * `ps -t` from sysctl(KERN_PROC_TTY) plus argv for that terminal's processes only (#24889).
 * Null sends the caller to `ps`, including when a foreground-group member's argv belongs to
 * another user: only root `ps` can name it, and the verdict reads exactly those rows.
 */
function readNativeTerminalRows(tty: string, rootPid: number): ProcessTableRow[] | null {
  try {
    const rows = getNativeProcessInfo()?.listTerminalProcesses(tty)
    const foregroundGroup = rows?.find((row) => row.pid === rootPid)?.tpgid
    if (!rows || rows.some((row) => row.command === null && row.pgid === foregroundGroup)) {
      return null
    }
    return rows.map(({ pid, ppid, pgid, tpgid, stat, command, name }) => ({
      pid,
      ppid,
      pgid,
      tpgid,
      stat,
      command: (command ?? name).trim()
    }))
  } catch {
    return null
  }
}

/** Every process on the terminal a pane's root process holds, or null when `ps` cannot say. */
export async function readTerminalProcessRows(rootPid: number): Promise<ProcessTableRow[] | null> {
  const tty = await terminalOf(rootPid)
  if (!tty) {
    return null
  }
  const native = readNativeTerminalRows(tty, rootPid)
  const stdout = native
    ? null
    : await ps(['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', tty])
  try {
    const rows = native ?? (stdout === null ? null : parseShellForegroundRows(stdout))
    // A pid reused by another process on another terminal reads as this pane's root missing.
    if (!rows?.some((row) => row.pid === rootPid)) {
      ttyByRootPid.delete(rootPid)
      return null
    }
    return rows
  } catch {
    return null
  }
}

function isShellCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^-/, '') ?? ''
  return isShellProcess(executable.split('/').pop() ?? executable)
}

/**
 * The terminal's foreground process group decides. The launched agent among its members, or any
 * member that is not a shell, is the agent: that finds it behind a wrapper that did not `exec` it,
 * whose own shell name leads the group. A group of shells alone is the shell, whether the pane's
 * own (the launch line has not run, or the agent exited) or a wrapper between commands. The pane's
 * root is never assumed to be the shell: a macOS pane runs its shell under `login`.
 */
export function judgeTerminalForeground(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  agent: TuiAgent
): 'agent' | 'shell' | 'unknown' {
  const root = rows.find((row) => row.pid === rootPid)
  const foregroundGroup = root?.tpgid
  if (foregroundGroup === undefined || foregroundGroup <= 0) {
    return 'unknown'
  }
  const front = rows.filter((row) => row.pgid === foregroundGroup)
  if (front.length === 0) {
    return 'unknown'
  }
  return front.some(
    (row) =>
      recognizeAgentProcessFromCommandLine(row.command)?.agent === agent ||
      !isShellCommand(row.command)
  )
    ? 'agent'
    : 'shell'
}
