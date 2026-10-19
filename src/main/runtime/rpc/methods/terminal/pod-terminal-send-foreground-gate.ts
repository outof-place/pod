// Fork-only (Pod): terminal.send's guarded writes (`requireAgentStatus: 'sendable'`, and any
// `agentPrompt`) find the agent's foreground process group before writing, and read the group again
// in each write's own synchronous block (pod-foreground-group-write-gate). The agent status alone can
// rest on a title, or on the foreground tracker's startup bootstrap, which names the launch's agent
// while its shell still holds the terminal.
import {
  createForegroundGroupWriteGate,
  type ForegroundGroupHost
} from '../../../pod-foreground-group-write-gate'

const NO_AGENT = 'terminal_guard_no_agent'

export type TerminalSendForegroundGate = {
  /** `before`, then the agent's group found in front of the terminal, or `terminal_guard_no_agent`. */
  withProof: (
    before?: (ptyId?: string) => void | Promise<void>
  ) => (ptyId?: string) => Promise<void>
  assertBeforeWrite: (ptyId: string) => void
}

export function createTerminalSendForegroundGate(
  runtime: ForegroundGroupHost
): TerminalSendForegroundGate {
  const group = createForegroundGroupWriteGate(runtime, null)
  return {
    withProof: (before) => async (ptyId) => {
      await before?.(ptyId)
      if (!ptyId || group.holds(ptyId)) {
        return
      }
      const verdict = await group.prove(ptyId)
      if (verdict === 'shell' || verdict === 'unknown') {
        throw new Error(NO_AGENT)
      }
    },
    assertBeforeWrite: (ptyId) => {
      if (!group.holds(ptyId)) {
        throw new Error(NO_AGENT)
      }
    }
  }
}
