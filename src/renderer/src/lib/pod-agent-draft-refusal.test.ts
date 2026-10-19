// Fork-only (Pod): a draft or prompt paste main refuses (no agent in front) sends no Enter and no
// plain write of its own; the caller sees an undelivered prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { submitPromptToAgentPty } from './agent-paste-draft'

const { sendRuntimePtyInputVerified } = vi.hoisted(() => ({
  sendRuntimePtyInputVerified: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {}, tabsByWorktree: {} }), subscribe: () => () => {} }
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified,
  inspectRuntimeTerminalProcess: vi.fn(),
  isRemoteRuntimePtyId: () => false
}))

const refusal = (reason: string) =>
  new Error(
    `Error invoking remote method 'pty:writeAccepted': Error: agent_not_in_foreground: ${reason}`
  )

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
  sendRuntimePtyInputVerified.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a refused agent paste', () => {
  it('sends no Enter after the paste was refused', async () => {
    sendRuntimePtyInputVerified.mockRejectedValue(refusal('shell'))

    const submitted = submitPromptToAgentPty({ tabId: 'tab-1', ptyId: 'pty-1', content: 'ship it' })
    await vi.runAllTimersAsync()

    await expect(submitted).resolves.toBe(false)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledOnce()
    expect(sendRuntimePtyInputVerified.mock.calls[0]?.[4]).toEqual({ requireAgentForeground: true })
  })

  it('reports the prompt undelivered when its Enter is refused', async () => {
    sendRuntimePtyInputVerified
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(refusal('group_changed'))

    const submitted = submitPromptToAgentPty({ tabId: 'tab-1', ptyId: 'pty-1', content: 'ship it' })
    await vi.runAllTimersAsync()

    await expect(submitted).resolves.toBe(false)
    expect(sendRuntimePtyInputVerified.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      ['\x1b[200~ship it\x1b[201~', { requireAgentForeground: true }],
      ['\r', { requireAgentForeground: true }]
    ])
  })
})
