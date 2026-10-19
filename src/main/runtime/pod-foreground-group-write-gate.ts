// Fork-only (Pod): the write-time check on text the user did not type into an agent's terminal. A
// read of the pane's terminal finds the agent's foreground process group; then, in the same
// synchronous block as each write, the terminal's foreground group is read again (tcgetpgrp through
// proc_info, else `ps`) and must still be that group. A title, a cached name, or the foreground
// tracker's 5 s startup bootstrap (which names the launch's agent while its shell still holds the
// terminal) never passes it. Local macOS and Linux panes only: an SSH or Windows pane can't be read
// synchronously from here, so `prove` answers `unsupported` and its callers keep their own checks.
import {
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import { readPosixPtyForegroundGroup } from '../pty/posix-pty-foreground-group'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import {
  judgeTerminalForeground,
  readTerminalProcessRows,
  terminalOf
} from './terminal-foreground-group'

type PaneProcessLister = Pick<RuntimePtyController, 'listProcesses'>

export type ForegroundGroupProof = { rootPid: number; tty: string; group: number }

export type ForegroundGroupVerdict = 'agent' | 'shell' | 'unknown' | 'unsupported'

export type ForegroundGroupHost = {
  /** The controller a local macOS or Linux pane is read through; null for any other pane. */
  foregroundGroupController?: (ptyId: string) => PaneProcessLister | null
}

/** One read of the pane's terminal: the agent's foreground group, or why there is none. */
export async function readForegroundAgentGroup(
  controller: PaneProcessLister,
  ptyId: string,
  agent: TuiAgent | null
): Promise<ForegroundGroupProof | 'shell' | 'unknown'> {
  const rootPid = (await controller.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
    (pane) => pane.id === ptyId
  )?.rootProcessId
  if (!rootPid) {
    return 'unknown'
  }
  const rows = await readTerminalProcessRows(rootPid)
  const tty = rows ? await terminalOf(rootPid) : null
  if (!rows || !tty) {
    return 'unknown'
  }
  const verdict = judgeTerminalForeground(rows, rootPid, agent)
  if (verdict !== 'agent') {
    return verdict
  }
  const group = rows.find((row) => row.pid === rootPid)?.tpgid
  return group !== undefined && group > 1 ? { rootPid, tty, group } : 'unknown'
}

export type ForegroundGroupWriteGate = {
  /** Whether this check can read the pane at all; `prove` answers `unsupported` where not. */
  reads: (ptyId: string) => boolean
  /** A fresh read; `agent` records the group every later write must still find in front. */
  prove: (ptyId: string) => Promise<ForegroundGroupVerdict>
  /** Read now, in the caller's synchronous block: whether the proven group still holds the
   *  terminal. Always true for a pane `prove` can't read; false before any proof. */
  holds: (ptyId: string) => boolean
}

/** `agent` null takes any recognized agent, for a write that names none. */
export function createForegroundGroupWriteGate(
  host: ForegroundGroupHost,
  agent: TuiAgent | null
): ForegroundGroupWriteGate {
  const proofs = new Map<string, ForegroundGroupProof>()
  const controllerFor = (ptyId: string): PaneProcessLister | null =>
    host.foregroundGroupController?.(ptyId) ?? null
  return {
    reads: (ptyId) => controllerFor(ptyId) !== null,
    prove: async (ptyId) => {
      const controller = controllerFor(ptyId)
      if (!controller) {
        return 'unsupported'
      }
      proofs.delete(ptyId)
      let proof: ForegroundGroupProof | 'shell' | 'unknown'
      try {
        proof = await readForegroundAgentGroup(controller, ptyId, agent)
      } catch {
        return 'unknown'
      }
      if (typeof proof === 'string') {
        return proof
      }
      proofs.set(ptyId, proof)
      return 'agent'
    },
    holds: (ptyId) => {
      if (!controllerFor(ptyId)) {
        return true
      }
      const proof = proofs.get(ptyId)
      if (proof && readPosixPtyForegroundGroup(proof.rootPid, proof.tty) === proof.group) {
        return true
      }
      proofs.delete(ptyId)
      return false
    }
  }
}

/** Runs `write` only while the proven group still holds the terminal, read in this same block. */
export function writeWhileGroupHolds(
  gate: ForegroundGroupWriteGate | undefined,
  ptyId: string,
  write: () => void
): boolean {
  if (gate && !gate.holds(ptyId)) {
    return false
  }
  write()
  return true
}

/** Writes `pasted`, waits for the host to take it in, then Enter as its own write, each only while
 *  the proven group still holds the terminal; null when both went out, else the write refused. */
export async function pasteThenSubmitWhileGroupHolds(
  gate: ForegroundGroupWriteGate | undefined,
  ptyId: string,
  pasted: string,
  write: (data: string) => void
): Promise<'paste' | 'submit' | null> {
  if (!writeWhileGroupHolds(gate, ptyId, () => write(pasted))) {
    return 'paste'
  }
  const delayMs = getAgentPromptSubmitDelayMs(process.platform, Buffer.byteLength(pasted, 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return writeWhileGroupHolds(gate, ptyId, () => write(AGENT_PROMPT_SUBMIT)) ? null : 'submit'
}
