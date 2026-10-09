import { isInterpreterProcessName } from './agent-command-line-entrypoint'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { getNativeProcessInfo } from './native-process-info'
import type { ProcessTableRow } from './process-table-snapshot'

/**
 * The kernel withholds another user's argv (root `login`, `sudo` and what it runs) but not its
 * executable path. That path answers every verdict unless the argv is what names the program:
 * an interpreter's script, or an agent whose flags decide what it is.
 */
function argvCanChangeVerdict(executable: string): boolean {
  const name = executable.split('/').pop()?.toLowerCase() ?? ''
  return (
    isInterpreterProcessName(name) ||
    recognizeAgentProcessFromCommandLine(`"${executable}"`, { includeHeadlessOneShot: true }) !==
      null
  )
}

/** Capture on the native worker; defer to ps when withheld argv could change a pane verdict. */
export async function readNativeFullProcessTable(): Promise<ProcessTableRow[] | null> {
  const native = getNativeProcessInfo()
  if (!native) {
    return null
  }
  try {
    const rows: ProcessTableRow[] = []
    for (const row of await native.listProcessesWithCommands()) {
      let command = row.command
      if (command === null) {
        // Why only terminal holders can force ps: every pane process holds its PTY, while the
        // root daemons that make up nearly all unreadable rows hold none and feed no pane verdict.
        if (row.tty !== '??' && (!row.path || argvCanChangeVerdict(row.path))) {
          return null
        }
        command = row.path ?? `(${row.name})`
      }
      // Kernel rows are well-formed, so the strict and lenient parse modes can share them.
      const { pid, ppid, pgid, tpgid, stat, tty, startTime } = row
      rows.push({ pid, ppid, pgid, tpgid, stat, tty, ...(startTime ? { startTime } : {}), command })
    }
    return rows.length > 0 ? rows : null
  } catch {
    return null
  }
}

/** The shell-foreground tier's columns (no `tty`/`lstart`) from the same kernel read. */
export async function readNativeShellForegroundRows(): Promise<ProcessTableRow[] | null> {
  return (
    (await readNativeFullProcessTable())?.map(({ pid, ppid, pgid, tpgid, stat, command }) => ({
      pid,
      ppid,
      pgid,
      tpgid,
      stat,
      command
    })) ?? null
  )
}
