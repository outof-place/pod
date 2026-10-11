import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import {
  encodeAgentArgsForStartupShell,
  withRequestedAgentArgs
} from './pod-create-terminal-agent-args'
import { POD_CREATE_TERMINAL_AGENT_ARGS_RUNTIME_CAPABILITY } from './pod-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { CreateTerminalTab } from './rpc-contract/session-tabs-schemas-params'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'

const hostile = ['--append-system-prompt', 'a b; echo injected', "it's \\ $HOME `id` $(id)", '']

function plan(agentArgs: readonly string[] | undefined, cmdOverride?: string) {
  const inputs = resolveAgentStartupPlanInputs({
    agent: 'claude',
    settings: {
      agentDefaultArgs: { claude: '--verbose' },
      ...(cmdOverride ? { agentCmdOverrides: { claude: cmdOverride } } : {})
    },
    platform: 'darwin',
    isRemote: false
  })
  return buildAgentStartupPlan({
    ...withRequestedAgentArgs(inputs, agentArgs),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
}

describe('session.tabs.createTerminal agentArgs (Pod)', () => {
  it('quotes each argument as Pod quotes agent arguments, replacing the configured ones', () => {
    const launch = plan(hostile)?.launchCommand
    expect(launch).toBe(
      ['claude', ...hostile.map((arg) => quoteStartupArg(arg, 'posix'))].join(' ')
    )
    expect(launch).not.toContain('--verbose')
  })

  it('reaches the program as the same argv, with no shell injection', () => {
    // printf stands in for the agent: each argument comes back on its own line, verbatim.
    const launch = plan(hostile, "printf '%s\\n'")?.launchCommand ?? ''
    const output = execFileSync('/bin/sh', ['-c', launch], { encoding: 'utf8' })
    expect(output.split('\n').slice(0, -1)).toEqual(hostile)
  })

  it('keeps the configured arguments without agentArgs, and drops them for an empty list', () => {
    expect(plan(undefined)?.launchCommand).toBe("claude '--verbose'")
    expect(plan([])?.launchCommand).toBe('claude')
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'round-trips through the %s tokenizer',
    (shell) => {
      const tokens = ['--model', 'a b; c', "it's", 'back`tick', 'caret^ "quote"', '']
      const encoded = encodeAgentArgsForStartupShell(tokens, shell)
      const parsed = tokenizeStartupCommand(encoded, shell)
      expect(parsed.ok && parsed.tokens).toEqual(tokens)
    }
  )

  it('needs an agent, no command and no control characters', () => {
    const base = { worktree: 'id:wt-1' }
    expect(
      CreateTerminalTab.safeParse({ ...base, agent: 'claude', agentArgs: ['--x', 'a b'] }).success
    ).toBe(true)
    expect(CreateTerminalTab.safeParse({ ...base, agentArgs: ['--x'] }).success).toBe(false)
    expect(
      CreateTerminalTab.safeParse({ ...base, agent: 'claude', command: 'ls', agentArgs: ['--x'] })
        .success
    ).toBe(false)
    expect(
      CreateTerminalTab.safeParse({ ...base, agent: 'claude', agentArgs: ['a\nb'] }).success
    ).toBe(false)
  })

  it('is advertised', () => {
    expect(RUNTIME_CAPABILITIES).toContain(POD_CREATE_TERMINAL_AGENT_ARGS_RUNTIME_CAPABILITY)
  })
})
