import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import { sendAgentForegroundInput } from './pod-agent-foreground-input'
import { neutralizePastedControls } from '../../../shared/agent-prompt-needs-paste'
import {
  AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS,
  AGENT_PROMPT_SUBMIT
} from '../../../shared/agent-prompt-injection'
import { wrapTerminalBracketedPasteText } from '../../../shared/terminal-bracketed-paste-text'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { GlobalSettings } from '../../../shared/global-settings-types'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

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
    // Fork-only (Pod): pasted as a draft is, so no byte of it acts as a key; Enter is its own write,
    // after a fresh scan still finds no shell in front.
    const pasted = wrapTerminalBracketedPasteText(neutralizePastedControls(prompt))
    if (!(await sendAgentForegroundInput(settings, ptyId, pasted, 'launch'))) {
      return false
    }
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
    )
    if (await freshScanFindsShell(settings, ptyId)) {
      return false
    }
    return await sendAgentForegroundInput(settings, ptyId, AGENT_PROMPT_SUBMIT, 'launch')
  } catch {
    return false
  }
}

/** Fork-only (Pod): the inspection can carry the terminal daemon's 5 s startup bootstrap, which
 *  names the launch's agent while its shell still holds the terminal; a fresh scan does not. Null
 *  (a remote pane, no fresh-scan RPC) is no new evidence, never a shell. */
async function freshScanFindsShell(
  settings: RuntimeOwnerSettings,
  ptyId: string
): Promise<boolean> {
  const confirmed = await confirmRuntimeTerminalForegroundProcess(settings, ptyId)
  return confirmed !== null && isShellProcess(confirmed.replace(/^-/, ''))
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
        if (await freshScanFindsShell(settings, ptyId)) {
          continue
        }
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
        process.hasChildProcesses &&
        !(await freshScanFindsShell(settings, ptyId))
      ) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
