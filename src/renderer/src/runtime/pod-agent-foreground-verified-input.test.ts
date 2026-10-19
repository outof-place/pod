// Fork-only (Pod): a guarded verified write asks main to prove the agent, and a refusal never falls
// back to a plain write of the same bytes. Only a plain false (an SSH pane main hands back) does.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import { AGENT_FOREGROUND_WRITE } from './pod-agent-foreground-write'

const write = vi.fn()
const writeAccepted = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { pty: { write, writeAccepted } } })
})

describe('a guarded verified write', () => {
  it('carries the guard to main', async () => {
    writeAccepted.mockResolvedValue(true)

    await expect(
      sendRuntimePtyInputVerified(null, 'pty-1', '\r', 'launch', AGENT_FOREGROUND_WRITE)
    ).resolves.toBe(true)
    expect(writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', '\r', 'launch', {
      requireAgentForeground: true
    })
  })

  it('rejects on a refusal and writes nothing else', async () => {
    writeAccepted.mockRejectedValue(
      new Error(
        "Error invoking remote method 'pty:writeAccepted': Error: agent_not_in_foreground: shell"
      )
    )

    await expect(
      sendRuntimePtyInputVerified(null, 'pty-1', 'fix it', 'launch', AGENT_FOREGROUND_WRITE)
    ).rejects.toThrow('agent_not_in_foreground: shell')
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps a settled write’s guard with its settlement', async () => {
    writeAccepted.mockResolvedValue(true)

    await sendRuntimePtyInputVerified(null, 'pty-1', '\r', 'driving', {
      requireWriteSettlement: true,
      requireAgentForeground: true
    })
    expect(writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', '\r', 'driving', {
      requireWriteSettlement: true,
      requireAgentForeground: true
    })
  })

  it('writes an SSH pane main handed back (false) as before', async () => {
    writeAccepted.mockResolvedValue(false)

    await expect(
      sendRuntimePtyInputVerified(null, 'pty-1', '\r', 'launch', AGENT_FOREGROUND_WRITE)
    ).resolves.toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('pty-1', '\r', 'launch')
  })

  it('sends an unguarded write as upstream did', async () => {
    writeAccepted.mockResolvedValue(true)

    await sendRuntimePtyInputVerified(null, 'pty-1', '\x03', 'driving')
    expect(writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', '\x03', 'driving')
  })
})
