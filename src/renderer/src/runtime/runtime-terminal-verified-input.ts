import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { readTerminalSendAcknowledgment } from '../../../shared/terminal-send-acknowledgment'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/**
 * True means accepted, false means refusal. `requireWriteSettlement` asks the local provider or a
 * current host for its acknowledgment; a lost one rejects. Fork-only (Pod): with
 * `requireAgentForeground`, main rejects unless an agent holds the terminal, and a rejection never
 * falls back to a plain write.
 */
export async function sendRuntimePtyInputVerified(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { requireWriteSettlement?: true; requireAgentForeground?: true }
): Promise<boolean> {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    if (options?.requireWriteSettlement) {
      // Why: an answer that dismisses its card must not fall back to an unacknowledged write.
      const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, options)
      if (accepted) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return accepted
    }
    // A refusal rejects here, so only a plain false (an SSH pane, a write main didn't take) falls back.
    const accepted = options?.requireAgentForeground
      ? await window.api.pty.writeAccepted(ptyId, data, inputKind, { requireAgentForeground: true })
      : await window.api.pty.writeAccepted(ptyId, data, inputKind)
    if (!accepted) {
      window.api.pty.write(ptyId, data, inputKind)
      // Why: SSH/local fallback writes are fire-and-forget. Callers use this
      // boolean to continue UX flow, while hook telemetry confirms real turns.
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    recordRuntimeTerminalInputForPtyId(ptyId)
    return accepted
  }

  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      target,
      'terminal.send',
      {
        terminal,
        text: data,
        client: DESKTOP_RUNTIME_CLIENT,
        ...(options?.requireWriteSettlement ? { requireWriteSettlement: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    const acknowledgment = readTerminalSendAcknowledgment(result)
    if (acknowledgment === 'unverifiable') {
      throw new Error('PTY write acknowledgment unavailable')
    }
    return acknowledgment === 'accepted'
  } catch (error) {
    if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
      return false
    }
    throw error
  }
}
