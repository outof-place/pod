// Fork-only (Pod): a worktree's startup draft and its stdin-after-start follow-up, written as guarded
// input. The text goes in one bracketed paste of plain text: no C0 control but tab and newline, no
// DEL and no C1, so nothing in it can end the paste or drive the agent's TUI. Every write is proven
// and fenced (pod-terminal-foreground-fence.ts), and the follow-up's Enter is a write of its own.
// A refusal throws to the caller; nothing of a refused write reaches the terminal.
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT,
  resolveAgentPromptSubmitDelayForAgent
} from '../../../shared/agent-prompt-injection'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  AGENT_NOT_IN_FOREGROUND,
  assertTerminalForegroundFence,
  type TerminalForegroundProver
} from './pod-terminal-foreground-fence'

export type StartupInputHost = TerminalForegroundProver & {
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

/** Tab and newline stay; a CR becomes a newline; every other C0 control, DEL and C1 goes. */
export function sanitizeStartupPasteText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- the controls are what this removes.
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function buildStartupPaste(text: string): string {
  return `${AGENT_PROMPT_BRACKETED_PASTE_START}${sanitizeStartupPasteText(text)}${AGENT_PROMPT_BRACKETED_PASTE_END}`
}

/** True only when a proof finds a shell in the pane's foreground group. */
export async function isStartupShellInFront(
  host: TerminalForegroundProver,
  ptyId: string,
  agent: TuiAgent | null
): Promise<boolean> {
  return (await host.proveTerminalAgentForegroundFence(ptyId, agent))?.verdict === 'shell'
}

/**
 * One guarded write: a fresh proof, then its fence re-read and the write in one synchronous block.
 * An SSH or Windows pane has no proof (null) and is written as before.
 */
export async function writeStartupInputGuarded(
  host: StartupInputHost,
  ptyId: string,
  agent: TuiAgent | null,
  data: string
): Promise<void> {
  const proof = await host.proveTerminalAgentForegroundFence(ptyId, agent)
  if (proof && proof.verdict !== 'agent') {
    throw new Error(AGENT_NOT_IN_FOREGROUND)
  }
  if (proof) {
    assertTerminalForegroundFence(proof.fence)
  }
  host.write(ptyId, data, 'launch')
}

/** The follow-up as a paste and, after the paste's submit delay, its Enter: two guarded writes. */
export async function writeStartupFollowupGuarded(
  host: StartupInputHost,
  ptyId: string,
  prompt: string
): Promise<void> {
  await writeStartupInputGuarded(host, ptyId, null, buildStartupPaste(prompt))
  const submitDelayMs = resolveAgentPromptSubmitDelayForAgent(process.platform, prompt, null)
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs))
  await writeStartupInputGuarded(host, ptyId, null, AGENT_PROMPT_SUBMIT)
}
