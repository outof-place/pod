// Fork-only (Pod): the last check of a guarded write to an agent's terminal, in the same synchronous
// block as the write. A proof reads the pane's terminal (terminal-foreground-group.ts) and keeps the
// foreground process group that holds the agent. Right before each write the group is read again,
// synchronously (pod-terminal-foreground-read.ts), and the bytes go out only while the same group is
// in front: a shell back in front, an agent that exited, or a read that fails refuses the write, with
// no byte written. Local macOS and Linux panes only; an SSH or Windows pane keeps its async guard.
// Phase 1 checks in the runtime: the terminal daemon holds the PTY and gets the bytes after the
// check, so the notify's trip to it and node-pty's write queue remain open. Every guarded writer
// goes out through writeIfForegroundSync, and a source scan checks that none writes beside it.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { recognizeAgentProcessFromCommandLine } from '../../../shared/agent-process-recognition'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  readTerminalForegroundGroupNow,
  type ForegroundGroupRefusal
} from './pod-terminal-foreground-read'
import type { RuntimePtyController } from '../../runtime/runtime-pty-controller-contract'
import {
  judgeTerminalForeground,
  readTerminalProcessRows,
  terminalOf
} from '../../runtime/terminal-foreground-group'

export const AGENT_NOT_IN_FOREGROUND = 'agent_not_in_foreground'

/** The pane's root process, its terminal, and the foreground group the proof found the agent in. */
export type TerminalForegroundFence = { rootPid: number; tty: string; foregroundGroup: number }

export type TerminalAgentForegroundProof =
  | { verdict: 'agent'; fence: TerminalForegroundFence }
  | { verdict: 'shell' | 'unknown' }

const UNKNOWN: TerminalAgentForegroundProof = { verdict: 'unknown' }

function isShellCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^-/, '') ?? ''
  return isShellProcess(executable.split('/').pop() ?? executable)
}

/** Without a known agent, any member of the front group that is an agent or not a shell. */
function judgeAnyAgent(
  rows: readonly ProcessTableRow[],
  foregroundGroup: number
): 'agent' | 'shell' | 'unknown' {
  const front = rows.filter((row) => row.pgid === foregroundGroup)
  if (front.length === 0) {
    return 'unknown'
  }
  return front.some(
    (row) =>
      recognizeAgentProcessFromCommandLine(row.command) !== null || !isShellCommand(row.command)
  )
    ? 'agent'
    : 'shell'
}

/** The proof on the pane's own host: null on an SSH or Windows pane, which keeps its async guard. */
export function proveTerminalAgentForegroundOnHost(
  controller: Pick<RuntimePtyController, 'listProcesses'> | null,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent: TuiAgent | null
): Promise<TerminalAgentForegroundProof | null> {
  return host.remote || host.windows
    ? Promise.resolve(null)
    : proveTerminalAgentForeground(controller, ptyId, agent)
}

/** A fresh read of a local pane's terminal: who holds its foreground group now. */
export async function proveTerminalAgentForeground(
  controller: Pick<RuntimePtyController, 'listProcesses'> | null,
  ptyId: string,
  agent: TuiAgent | null
): Promise<TerminalAgentForegroundProof> {
  try {
    const panes = await controller?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)
    const rootPid = panes?.find((pane) => pane.id === ptyId)?.rootProcessId
    if (!rootPid) {
      return UNKNOWN
    }
    const tty = await terminalOf(rootPid)
    const rows = tty ? await readTerminalProcessRows(rootPid) : null
    const foregroundGroup = rows?.find((row) => row.pid === rootPid)?.tpgid
    if (!tty || !rows || foregroundGroup === undefined || foregroundGroup <= 1) {
      return UNKNOWN
    }
    const verdict = agent
      ? judgeTerminalForeground(rows, rootPid, agent)
      : judgeAnyAgent(rows, foregroundGroup)
    return verdict === 'agent' ? { verdict, fence: { rootPid, tty, foregroundGroup } } : { verdict }
  } catch {
    return UNKNOWN
  }
}

export type ForegroundFenceRefusal = ForegroundGroupRefusal | 'group_changed'

/** Synchronous: why the fence no longer holds, or null while the proof's group is in front. */
export function checkTerminalForegroundFence(
  fence: TerminalForegroundFence
): ForegroundFenceRefusal | null {
  const read = readTerminalForegroundGroupNow(fence.rootPid, fence.tty)
  if (!read.ok) {
    return read.reason
  }
  return read.group === fence.foregroundGroup ? null : 'group_changed'
}

export function isTerminalForegroundFenceHeld(fence: TerminalForegroundFence): boolean {
  return checkTerminalForegroundFence(fence) === null
}

/** Throws `<error>: <reason>` when the fence no longer holds. */
export function assertTerminalForegroundFence(
  fence: TerminalForegroundFence,
  error = AGENT_NOT_IN_FOREGROUND
): void {
  const refusal = checkTerminalForegroundFence(fence)
  if (refusal) {
    throw new Error(`${error}: ${refusal}`)
  }
}

/**
 * The one way a guarded write goes out: the guard's synchronous check, then the write, in one call
 * with nothing between them. A check that throws refuses the write, and no byte of it is sent.
 */
export function writeIfForegroundSync<T>(
  check: ((ptyId: string) => void) | undefined,
  ptyId: string,
  write: () => T
): T {
  check?.(ptyId)
  return write()
}

export type TerminalForegroundProver = {
  proveTerminalAgentForegroundFence(
    ptyId: string,
    agent: TuiAgent | null
  ): Promise<TerminalAgentForegroundProof | null>
}

/** terminal.send's `sendable` guard: a proof before each write, and its check in the write's block. */
export type SendableForegroundFence = {
  /** No pty yet (the first check of a send) proves nothing; the write's own check then refuses. */
  prove: (ptyId: string | undefined) => Promise<void>
  atWrite: (ptyId: string) => void
}

export function createSendableForegroundFence(
  runtime: TerminalForegroundProver,
  refusal = 'terminal_guard_no_agent'
): SendableForegroundFence {
  // A pty proven on a host that can't prove it (SSH, Windows) maps to null: its async guard decides.
  const proofs = new Map<string, TerminalForegroundFence | null>()
  return {
    prove: async (ptyId) => {
      if (!ptyId) {
        return
      }
      proofs.delete(ptyId)
      const proof = await runtime.proveTerminalAgentForegroundFence(ptyId, null)
      if (proof && proof.verdict !== 'agent') {
        throw new Error(refusal)
      }
      proofs.set(ptyId, proof?.verdict === 'agent' ? proof.fence : null)
    },
    atWrite: (ptyId) => {
      if (!proofs.has(ptyId)) {
        throw new Error(refusal)
      }
      const fence = proofs.get(ptyId)
      if (fence) {
        assertTerminalForegroundFence(fence, refusal)
      }
    }
  }
}
