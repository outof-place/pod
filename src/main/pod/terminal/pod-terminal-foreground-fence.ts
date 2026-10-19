// Fork-only (Pod): the last check of a guarded write to an agent's terminal, in the same synchronous
// block as the write. A proof reads the pane's terminal (terminal-foreground-group.ts) and keeps the
// foreground process group that holds the agent. Right before each write the group is read again,
// synchronously (pod-terminal-foreground-read.ts), and the bytes go out only while the same group is
// in front: a shell back in front, an agent that exited, or a read that fails refuses the write, with
// no byte written. Local macOS and Linux panes only; an SSH or Windows pane keeps its async guard,
// and an unguarded agent prompt on SSH asks the pane's relay who is in front (withAgentForegroundGate).
// Phase 1 checks in the runtime: the terminal daemon holds the PTY and gets the bytes after the
// check, so the notify's trip to it and node-pty's write queue remain open. Every guarded writer
// goes out through writeIfForegroundSync, and a source scan checks that none writes beside it.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  isExpectedAgentProcess,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../../shared/agent-process-recognition'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  readTerminalForegroundGroupNow,
  type ForegroundGroupRefusal
} from './pod-terminal-foreground-read'
import type { RuntimePtyController } from '../../runtime/runtime-pty-controller-contract'
import { readTerminalProcessRows, terminalOf } from '../../runtime/terminal-foreground-group'

export const AGENT_NOT_IN_FOREGROUND = 'agent_not_in_foreground'

/** The pane's root process, its terminal, and the foreground group the proof found the agent in. */
export type TerminalForegroundFence = { rootPid: number; tty: string; foregroundGroup: number }

/** `not_agent`: something other than a shell and other than an agent holds the terminal (ssh, sudo,
 *  a REPL, another agent than the one named). */
export type TerminalAgentForegroundProof =
  | { verdict: 'agent'; fence: TerminalForegroundFence }
  | { verdict: 'shell' | 'not_agent' | 'unknown' }

const UNKNOWN: TerminalAgentForegroundProof = { verdict: 'unknown' }
const SHELL: TerminalAgentForegroundProof = { verdict: 'shell' }

/** A login shell is reported as `-zsh`. */
function executableOf(command: string): string {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^-/, '') ?? ''
  return executable.split('/').pop() ?? executable
}

function isShellCommand(command: string): boolean {
  return isShellProcess(executableOf(command))
}

/**
 * The named agent, by its own name or by the process it runs as: a launch mode can run another
 * agent's process (Agent Teams runs `claude`). Any recognized agent when none is named.
 */
function isAgentCommand(command: string, agent: TuiAgent | null): boolean {
  const recognized = recognizeAgentProcessFromCommandLine(command)
  if (agent === null || recognized?.agent === agent) {
    return recognized !== null
  }
  const expected = TUI_AGENT_CONFIG[agent].expectedProcess
  return (
    isExpectedAgentProcess(executableOf(command), expected) ||
    (recognized !== null && TUI_AGENT_CONFIG[recognized.agent].expectedProcess === expected)
  )
}

/**
 * The front group holds the agent only when a member is recognized as one: the named agent, or any
 * agent when none is named. Not a process that merely isn't a shell: `sudo -s`, `ssh host` or a
 * REPL in front would take a note or a prompt as commands.
 */
function judgeFrontGroup(
  rows: readonly ProcessTableRow[],
  foregroundGroup: number,
  agent: TuiAgent | null
): Exclude<TerminalAgentForegroundProof['verdict'], 'unknown'> | 'unknown' {
  const front = rows.filter((row) => row.pgid === foregroundGroup)
  if (front.length === 0) {
    return 'unknown'
  }
  if (front.some((row) => isAgentCommand(row.command, agent))) {
    return 'agent'
  }
  return front.every((row) => isShellCommand(row.command)) ? 'shell' : 'not_agent'
}

/**
 * The proof on the pane's own host. A Windows pane has none (null), and neither has an SSH pane,
 * which keeps its async guard, unless `relayShell` asks its relay who is in front: a shell named
 * there proves the shell, and anything else stays unproven (null). No fence on SSH: the read is async.
 * The relay names a process, not its command line, so `sudo`, a REPL or a nested `ssh` in front of an
 * SSH pane stays unproven too: a node REPL reads like a node-based agent. Phase 2 reads argv there.
 */
export async function proveTerminalAgentForegroundOnHost(
  controller: Pick<RuntimePtyController, 'listProcesses' | 'getForegroundProcess'> | null,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent: TuiAgent | null,
  relayShell = false
): Promise<TerminalAgentForegroundProof | null> {
  if (host.windows) {
    return null
  }
  if (!host.remote) {
    return proveTerminalAgentForeground(controller, ptyId, agent)
  }
  return relayShell ? proveRelayShellInFront(controller, ptyId) : null
}

/** An SSH pane's relay read: a shell it names in front proves the shell; anything else stays unproven. */
export async function proveRelayShellInFront(
  relay: { getForegroundProcess(ptyId: string): Promise<string | null> } | null,
  ptyId: string
): Promise<TerminalAgentForegroundProof | null> {
  try {
    const name = await relay?.getForegroundProcess(ptyId)
    return name && isShellCommand(name) && !recognizeAgentProcess(name) ? SHELL : null
  } catch {
    return null
  }
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
    const verdict = judgeFrontGroup(rows, foregroundGroup, agent)
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
    agent: TuiAgent | null,
    relayShell?: boolean
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
  refusal = 'terminal_guard_no_agent',
  agent: TuiAgent | null = null,
  relayShell = false
): SendableForegroundFence {
  // A pty proven on a host that can't prove it (SSH, Windows) maps to null: its async guard decides.
  const proofs = new Map<string, TerminalForegroundFence | null>()
  return {
    prove: async (ptyId) => {
      if (!ptyId) {
        return
      }
      proofs.delete(ptyId)
      const proof = await runtime.proveTerminalAgentForegroundFence(ptyId, agent, relayShell)
      if (proof && proof.verdict !== 'agent') {
        throw new Error(`${refusal}: ${proof.verdict}`)
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

type AgentWriteHooks = {
  beforeWrite?: (ptyId: string) => void | Promise<void>
  atWrite?: (ptyId: string) => void
}

/**
 * An agent prompt whose caller brings no guard of its own (dispatch --inject, a coordinator's task,
 * the CLI's prompt send) gets the default one: a proof before each write after the caller's own
 * beforeWrite, and its fence in the write's block. On an SSH pane the relay's read stands in for the
 * proof, and refuses a shell it names in front. A caller with an atWrite keeps its own.
 */
export function withAgentForegroundGate<T extends AgentWriteHooks>(
  runtime: TerminalForegroundProver,
  options: T,
  agent: TuiAgent | null
): T {
  if (options.atWrite) {
    return options
  }
  const gate = createSendableForegroundFence(runtime, AGENT_NOT_IN_FOREGROUND, agent, true)
  return {
    ...options,
    beforeWrite: async (ptyId: string): Promise<void> => {
      await options.beforeWrite?.(ptyId)
      await gate.prove(ptyId)
    },
    atWrite: gate.atWrite
  }
}
