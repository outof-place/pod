// Fork-only (Pod): the option a classic-window write of agent text the user didn't type carries.
// Main then writes it only while an agent holds the terminal, and a refusal rejects with
// "agent_not_in_foreground: <reason>" instead of falling back to a plain write.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { sendRuntimePtyInputVerified } from './runtime-terminal-inspection'

export const AGENT_FOREGROUND_WRITE = { requireAgentForeground: true } as const

/** A verified write of agent text, sent with the guard. */
export function sendAgentForegroundInput(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): Promise<boolean> {
  return sendRuntimePtyInputVerified(settings, ptyId, data, inputKind, AGENT_FOREGROUND_WRITE)
}
