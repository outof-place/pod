import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  AGENT_PROMPT_SUBMIT
} from '../../../shared/agent-prompt-injection'
import { buildStartupPaste } from '../../../shared/pod-agent-paste-text'
import { readAgentForegroundRefusal } from '../../../shared/pod-agent-foreground-refusal'
import { sendAgentForegroundInput } from '@/runtime/pod-agent-foreground-write'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

const FOLLOWUP_PROOF_RETRIES = 20
const FOLLOWUP_PROOF_RETRY_MS = 250
// A proof that refuses before any byte is written; a fence refusal can follow a written chunk.
const BEFORE_WRITE_REFUSALS = new Set(['shell', 'not_agent', 'unknown'])

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  expectedProcess: string
  prompt: string
  settings: RuntimeOwnerSettings
}): Promise<boolean> {
  const { ptyId, expectedProcess, prompt, settings } = args
  if (!(await waitForAgentForeground(ptyId, expectedProcess, settings))) {
    return false
  }
  try {
    // Fork-only (Pod): one filtered paste, then its own Enter, each only while an agent holds the
    // terminal, as the host's follow-up is written (pod-startup-input-write.ts).
    if (!(await pasteOnceAgentProven(settings, ptyId, buildStartupPaste(prompt)))) {
      return false
    }
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
    )
    return await sendAgentForegroundInput(settings, ptyId, AGENT_PROMPT_SUBMIT, 'launch')
  } catch {
    return false
  }
}

// Why: the tracker can name the agent while its shell still holds the terminal. A paste the proof
// refused wrote nothing, so it is tried again for a few seconds.
async function pasteOnceAgentProven(
  settings: RuntimeOwnerSettings,
  ptyId: string,
  paste: string
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sendAgentForegroundInput(settings, ptyId, paste, 'launch')
    } catch (error) {
      const refusal = readAgentForegroundRefusal(error)
      if (!refusal || !BEFORE_WRITE_REFUSALS.has(refusal) || attempt >= FOLLOWUP_PROOF_RETRIES) {
        throw error
      }
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, FOLLOWUP_PROOF_RETRY_MS))
  }
}

// Why: delayed follow-ups must not type into an arbitrary shell. Require a
// positive readiness signal before writing user/task text to the PTY.
async function waitForAgentForeground(
  ptyId: string,
  expectedProcess: string,
  settings: RuntimeOwnerSettings
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
      // Why: interpreter-wrapped agents (aider, mistral-vibe are pip console
      // scripts) surface a python/node foreground comm, so the exact-name check
      // never matches — locally when the ps-table resolver can't pin the child,
      // and over SSH when the relay falls back to the bare interpreter name. If
      // the foreground is a known agent wrapper (not a shell) with a live
      // non-shell child, the agent has taken over the PTY and can accept input.
      if (
        attempt >= 4 &&
        isAgentForegroundWrapperProcess(foreground) &&
        !isShellProcess(foreground) &&
        process.hasChildProcesses
      ) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
