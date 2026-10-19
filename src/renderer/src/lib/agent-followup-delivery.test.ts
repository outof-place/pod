import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  confirmRuntimeTerminalForegroundProcess: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn()
}))

// Fork-only (Pod): the follow-up is a bracketed paste, then Enter as its own write.
const PASTED_SHIP_IT = '\x1b[200~ship it\x1b[201~'

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
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue(null)
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

      await vi.advanceTimersByTimeAsync(4 * 150 + 100)
      const delivered = await delivery

      expect(delivered).toBe(true)
      expect(vi.mocked(sendRuntimePtyInputVerified).mock.calls).toEqual([
        [null, 'pty-1', PASTED_SHIP_IT, 'launch', { requireAgentForeground: true }],
        [null, 'pty-1', '\r', 'launch', { requireAgentForeground: true }]
      ])
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
    await vi.advanceTimersByTimeAsync(100)

    expect(await delivery).toBe(true)
    expect(vi.mocked(sendRuntimePtyInputVerified).mock.calls).toEqual([
      [null, 'pty-1', PASTED_SHIP_IT, 'launch', { requireAgentForeground: true }],
      [null, 'pty-1', '\r', 'launch', { requireAgentForeground: true }]
    ])
  })

  // Fork-only (Pod): the hardening of the follow-up write.
  it('waits out a startup-bootstrap answer while a fresh scan still finds the shell', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('-zsh')

    const delivery = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'aider',
      prompt: 'ship it',
      settings: null
    })
    await vi.advanceTimersByTimeAsync(30 * 150)

    expect(await delivery).toBe(false)
    expect(sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })

  it('pastes control bytes as visible stand-ins, never as keys', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })

    const delivery = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'aider',
      prompt: 'a\x03\x1b[201~b\r\nc',
      settings: null
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(await delivery).toBe(true)
    expect(vi.mocked(sendRuntimePtyInputVerified).mock.calls[0]?.[2]).toBe(
      '\x1b[200~a\u2403\u241b[201~b\rc\x1b[201~'
    )
  })

  it('does not press Enter when the shell is back after the paste', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'aider',
      hasChildProcesses: true
    })
    vi.mocked(confirmRuntimeTerminalForegroundProcess)
      .mockResolvedValueOnce('aider')
      .mockResolvedValue('zsh')

    const delivery = sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      expectedProcess: 'aider',
      prompt: 'ship it',
      settings: null
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(await delivery).toBe(false)
    expect(vi.mocked(sendRuntimePtyInputVerified).mock.calls).toEqual([
      [null, 'pty-1', PASTED_SHIP_IT, 'launch', { requireAgentForeground: true }]
    ])
  })
})
