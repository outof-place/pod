// Fork-only (Pod): renderer writes of agent text (a paste, its Enter, a follow-up) ask main to land
// them only while an agent's foreground process group holds the pane's terminal (main's
// pod-agent-foreground-write); a refusal throws instead of falling back to an unchecked write.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export function sendAgentForegroundInput(
  settings: RuntimeOwnerSettings,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): Promise<boolean> {
  return sendRuntimePtyInputVerified(settings, ptyId, data, inputKind, {
    requireAgentForeground: true
  })
}

export function sendAgentForegroundDraftPaste(
  settings: RuntimeOwnerSettings,
  ptyId: string,
  content: string,
  inputKind: TerminalInputKind
): Promise<boolean> {
  return sendAgentDraftPasteContentNow(settings, ptyId, content, inputKind, (data) =>
    sendAgentForegroundInput(settings, ptyId, data, inputKind)
  )
}
