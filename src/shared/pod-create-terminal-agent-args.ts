// Fork-only (Pod): session.tabs.createTerminal's `agentArgs`, the agent's arguments as argv tokens.
import { z } from 'zod'
import type { AgentStartupPlanInputs } from './agent-startup-plan-inputs'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export const POD_CREATE_TERMINAL_AGENT_ARGS_MAX = 64
export const POD_CREATE_TERMINAL_AGENT_ARG_MAX_LENGTH = 4096

// C0, DEL, C1 and U+2028/2029: the launch line is typed into a shell.
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true
    }
  }
  return false
}

/** One argv token each, replacing the agent's configured arguments ([] = none), as Pod's
 *  source-control actions launch with their recipe's. Only with `agent`. */
export const PodCreateTerminalAgentArgs = z
  .array(
    z
      .string()
      .max(POD_CREATE_TERMINAL_AGENT_ARG_MAX_LENGTH)
      .refine((value) => !hasControlCharacter(value), {
        message: 'Agent arguments cannot contain control characters'
      })
  )
  .max(POD_CREATE_TERMINAL_AGENT_ARGS_MAX)
  .optional()

function encodeToken(token: string, shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    // The Windows tokenizer reads a backtick as an escape even inside single quotes.
    return `'${token.replace(/`/g, '``').replace(/'/g, "''")}'`
  }
  if (shell === 'cmd') {
    return `"${token.replace(/\^/g, '^^').replace(/"/g, '^"')}"`
  }
  // Single quotes are literal to the Unix tokenizer; an apostrophe closes, is double-quoted, reopens.
  return `'${token.replace(/'/g, `'"'"'`)}'`
}

/** The tokens as the string the launch path tokenizes, so each reaches `quoteStartupArg` as given
 *  (no raw join); throws when the shell's tokenizer wouldn't give them back. */
export function encodeAgentArgsForStartupShell(
  tokens: readonly string[],
  shell: AgentStartupShell
): string {
  const encoded = tokens.map((token) => encodeToken(token, shell)).join(' ')
  const parsed = tokenizeStartupCommand(encoded, shell)
  if (
    !parsed.ok ||
    parsed.tokens.length !== tokens.length ||
    parsed.tokens.some((token, index) => token !== tokens[index])
  ) {
    throw new Error('Agent arguments cannot be passed to this host shell.')
  }
  return encoded
}

/** The launch inputs with the request's arguments in place of the configured ones. */
export function withRequestedAgentArgs(
  inputs: AgentStartupPlanInputs,
  agentArgs: readonly string[] | undefined
): AgentStartupPlanInputs {
  if (agentArgs === undefined) {
    return inputs
  }
  const shell = resolveStartupShell(inputs.platform, inputs.shell)
  return { ...inputs, agentArgs: encodeAgentArgsForStartupShell(agentArgs, shell) }
}
