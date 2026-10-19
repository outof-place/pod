import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-prompt-injection'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn()
}))

// Fork-only (Pod): the follow-up is a filtered paste and its own Enter, each a guarded write.
function expectGuardedPasteAndEnter(): void {
  expect(vi.mocked(sendRuntimePtyInputVerified).mock.calls).toEqual([
    [null, 'pty-1', '\x1b[200~ship it\x1b[201~', 'launch', { requireAgentForeground: true }],
    [null, 'pty-1', '\r', 'launch', { requireAgentForeground: true }]
  ])
}

// The interpreter-wrapped agents that deliver their prompt over stdin after the
// process starts. These are pip console-scripts, so the PTY foreground comm is
// python/python3 — never the agent's own name.
const INTERPRETER_WRAPPED_AGENTS = [
  { agent: 'aider', expectedProcess: TUI_AGENT_CONFIG.aider.expectedProcess }
] as const

describe('sendFollowupPromptWhenAgentReady — interpreter-wrapped agents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('globalThis', globalThis)
    // Deliver the prompt write eagerly so the test does not depend on retries.
    vi.mocked(sendRuntimePtyInputVerified).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  for (const { agent, expectedProcess } of INTERPRETER_WRAPPED_AGENTS) {
    it(`types the prompt once ${agent} is up behind a python3 wrapper with a live child`, async () => {
      // The console-script agent is running: foreground comm is python3 and the
      // PTY has a non-shell child. The exact agent name never appears.
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'python3',
        hasChildProcesses: true
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess,
        prompt: 'ship it',
        settings: null
      })

      await vi.advanceTimersByTimeAsync(4 * 150 + AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)
      const delivered = await delivery

      expect(delivered).toBe(true)
      expectGuardedPasteAndEnter()
    })

    it(`still refuses to type into a bare ${agent} shell foreground`, async () => {
      // No agent yet: foreground is a plain shell with no non-shell child. The
      // guard must NOT write user text into an arbitrary shell.
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'zsh',
        hasChildProcesses: false
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess,
        prompt: 'ship it',
        settings: null
      })

      await vi.advanceTimersByTimeAsync(29 * 150)
      const delivered = await delivery

      expect(delivered).toBe(false)
      expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    })

    it(`refuses to type into a ${agent} wrapper without a live child`, async () => {
      vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
        foregroundProcess: 'python3',
        hasChildProcesses: false
      })

      const delivery = sendFollowupPromptWhenAgentReady({
        ptyId: 'pty-1',
        expectedProcess,
        prompt: 'ship it',
        settings: null
      })

      await vi.advanceTimersByTimeAsync(29 * 150)
      const delivered = await delivery

      expect(delivered).toBe(false)
      expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    })
  }

  it('types immediately when the resolver already returns the agent name (local ps path)', async () => {
    // On local desktop the ps-table resolver usually resolves python3 → aider
    // before we poll; the exact-match path must keep working.
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })

    const delivery = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'aider',
      prompt: 'ship it',
      settings: null
    })
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)

    expect(await delivery).toBe(true)
    expectGuardedPasteAndEnter()
  })
})

// Fork-only (Pod): main refuses a paste the agent isn't in front for, with no byte written.
describe('sendFollowupPromptWhenAgentReady — guarded writes', () => {
  const refusal = (reason: string) =>
    new Error(
      `Error invoking remote method 'pty:writeAccepted': Error: agent_not_in_foreground: ${reason}`
    )

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function deliver() {
    return sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'aider',
      prompt: 'ship it',
      settings: null
    })
  }

  it('tries the paste again while the shell still holds the terminal, then sends its Enter', async () => {
    vi.mocked(sendRuntimePtyInputVerified)
      .mockRejectedValueOnce(refusal('shell'))
      .mockRejectedValueOnce(refusal('not_agent'))
      .mockResolvedValue(true)

    const delivery = deliver()
    await vi.advanceTimersByTimeAsync(2 * 250 + AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)

    expect(await delivery).toBe(true)
    const writes = vi.mocked(sendRuntimePtyInputVerified).mock.calls.map((call) => call[2])
    expect(writes).toEqual([
      '\x1b[200~ship it\x1b[201~',
      '\x1b[200~ship it\x1b[201~',
      '\x1b[200~ship it\x1b[201~',
      '\r'
    ])
  })

  it('gives up after a few seconds of a shell in front, with no Enter', async () => {
    vi.mocked(sendRuntimePtyInputVerified).mockRejectedValue(refusal('shell'))

    const delivery = deliver()
    await vi.advanceTimersByTimeAsync(21 * 250)

    expect(await delivery).toBe(false)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(21)
    expect(
      vi.mocked(sendRuntimePtyInputVerified).mock.calls.every((call) => call[2] !== '\r')
    ).toBe(true)
  })

  it('does not paste again after a refusal that can follow a written chunk', async () => {
    vi.mocked(sendRuntimePtyInputVerified).mockRejectedValueOnce(refusal('group_changed'))

    const delivery = deliver()
    await vi.advanceTimersByTimeAsync(1000)

    expect(await delivery).toBe(false)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledOnce()
  })

  it('reports no delivery when the Enter is refused after the paste', async () => {
    vi.mocked(sendRuntimePtyInputVerified)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(refusal('group_changed'))

    const delivery = deliver()
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS)

    expect(await delivery).toBe(false)
  })
})
