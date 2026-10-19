// Fork-only (Pod): the classic window's agent text through pty:writeAccepted with
// requireAgentForeground: a shell in front gets no byte, the agent does, a group that changes between
// chunks stops the rest, and an SSH pane's relay refuses a shell it names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WRITE_ACCEPTED,
  writeRefused,
  type WriteSettlement
} from '../../../shared/pty-write-settlement'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../shared/terminal-input'
import { ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { createPtyWriteInput } from '../../ipc/pty/ipc/write-input'
import type { PtyRendererDelivery } from '../../ipc/pty/session'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { TerminalAgentForegroundProof } from './pod-terminal-foreground-fence'
import { notTakenWrite } from './pod-agent-foreground-ipc-write'

const fence = vi.hoisted((): { groupNow: number | null } => ({ groupNow: null }))
const mocks = vi.hoisted(() => ({
  provider: {
    hasPty: vi.fn(() => true),
    write: vi.fn(),
    writeWithSettlement: vi.fn<(id: string, data: string) => WriteSettlement>(),
    getForegroundProcess: vi.fn<(id: string) => Promise<string | null>>()
  }
}))
vi.mock('../../ipc/pty/provider/registry', () => ({ tryGetProviderForPty: () => mocks.provider }))
vi.mock('./pod-terminal-foreground-read', () => ({
  readTerminalForegroundGroupNow: () =>
    fence.groupNow === null
      ? { ok: false, reason: 'read_failed' }
      : { ok: true, group: fence.groupNow }
}))

const id = 'pty-agent'
const AGENT_GROUP = 200
const AGENT_PROOF: TerminalAgentForegroundProof = {
  verdict: 'agent',
  fence: { rootPid: 100, tty: 'ttys007', foregroundGroup: AGENT_GROUP }
}
const mainWindow: PtyRendererDelivery = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: {
    id: 1,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}
const runtime = {
  getDriver: vi.fn(() => ({ kind: 'idle' })),
  proveTerminalAgentForegroundFence: vi.fn<() => Promise<TerminalAgentForegroundProof | null>>(),
  terminalRunFacts: { recordInput: vi.fn() },
  noteRemoteDesktopHostInput: vi.fn(),
  observeClaudeTerminalEvidence: vi.fn()
}
function input(withRuntime = true) {
  return createPtyWriteInput({
    mainWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write path reads only the members stubbed above.
    runtime: withRuntime ? (runtime as unknown as OrcaRuntimeService) : undefined
  })
}
function agentWrite(data: string, extra: { requireWriteSettlement?: true } = {}) {
  return input().writePtyInputAccepted({
    id,
    data,
    inputKind: 'driving',
    requireAgentForeground: true,
    ...extra
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fence.groupNow = null
  mocks.provider.hasPty.mockReturnValue(true)
  mocks.provider.writeWithSettlement.mockReturnValue(WRITE_ACCEPTED)
  runtime.getDriver.mockReturnValue({ kind: 'idle' })
})
afterEach(() => {
  ptyOwnership.delete(id)
})

describe('agent text on a local pane', () => {
  beforeEach(() => {
    ptyOwnership.set(id, 'local')
  })

  it.each(['shell', 'not_agent', 'unknown'] as const)(
    'writes nothing and rejects when the proof finds %s',
    async (verdict) => {
      runtime.proveTerminalAgentForegroundFence.mockResolvedValue({ verdict })

      await expect(agentWrite('\x1b[200~fix it\x1b[201~')).rejects.toThrow(
        `agent_not_in_foreground: ${verdict}`
      )
      expect(mocks.provider.write).not.toHaveBeenCalled()
      expect(runtime.terminalRunFacts.recordInput).not.toHaveBeenCalled()
    }
  )

  it('writes while the proven group holds the terminal', async () => {
    runtime.proveTerminalAgentForegroundFence.mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP

    await expect(agentWrite('\r')).resolves.toBe(true)
    expect(mocks.provider.write).toHaveBeenCalledExactlyOnceWith(id, '\r')
  })

  it('stops a large paste at the chunk after the group changed, and rejects', async () => {
    runtime.proveTerminalAgentForegroundFence.mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP
    mocks.provider.write.mockImplementationOnce(() => {
      fence.groupNow = 101
    })

    await expect(agentWrite('x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2))).rejects.toThrow(
      'agent_not_in_foreground: group_changed'
    )
    expect(mocks.provider.write).toHaveBeenCalledOnce()
  })

  it('refuses when no runtime can prove the pane', async () => {
    await expect(
      input(false).writePtyInputAccepted({
        id,
        data: '\r',
        inputKind: 'driving',
        requireAgentForeground: true
      })
    ).rejects.toThrow('agent_not_in_foreground: unknown')
    expect(mocks.provider.write).not.toHaveBeenCalled()
  })

  it('leaves a write without the flag as it was, with no proof', async () => {
    await expect(
      Promise.resolve(input().writePtyInputAccepted({ id, data: '\x03', inputKind: 'driving' }))
    ).resolves.toBe(true)
    expect(runtime.proveTerminalAgentForegroundFence).not.toHaveBeenCalled()
  })

  it('keeps the mobile lock first, as a refusal rather than a false', async () => {
    runtime.getDriver.mockReturnValue({ kind: 'mobile' })

    await expect(agentWrite('\r')).rejects.toThrow('agent_not_in_foreground: mobile_driver')
    expect(runtime.proveTerminalAgentForegroundFence).not.toHaveBeenCalled()
  })

  // A local false would let the renderer fall back to a plain write of the same bytes.
  it('refuses, never answers false, for a pane with no PTY', async () => {
    mocks.provider.hasPty.mockReturnValue(false)

    await expect(agentWrite('\r')).rejects.toThrow('agent_not_in_foreground: no_pty')
    expect(runtime.proveTerminalAgentForegroundFence).not.toHaveBeenCalled()
    expect(mocks.provider.write).not.toHaveBeenCalled()
  })

  it('refuses a write the provider didn’t take', async () => {
    runtime.proveTerminalAgentForegroundFence.mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP
    mocks.provider.write.mockReturnValue(false)

    await expect(agentWrite('\r')).rejects.toThrow('agent_not_in_foreground: write_not_accepted')
  })

  it('refuses a settled write the provider refused', async () => {
    runtime.proveTerminalAgentForegroundFence.mockResolvedValue(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP
    mocks.provider.writeWithSettlement.mockReturnValue(writeRefused('endpoint_disconnected'))

    await expect(agentWrite('\r', { requireWriteSettlement: true })).rejects.toThrow(
      'agent_not_in_foreground: write_not_accepted'
    )
  })
})

describe('agent text on an SSH pane', () => {
  beforeEach(() => {
    ptyOwnership.set(id, 'ssh:connection-1')
  })

  it.each(['-zsh', 'bash'])('rejects when the relay names %s in front', async (name) => {
    mocks.provider.getForegroundProcess.mockResolvedValue(name)

    await expect(agentWrite('\r')).rejects.toThrow('agent_not_in_foreground: shell')
    expect(mocks.provider.write).not.toHaveBeenCalled()
    expect(mocks.provider.writeWithSettlement).not.toHaveBeenCalled()
  })

  it('hands an unproven pane back to the renderer’s route, writing nothing itself', async () => {
    mocks.provider.getForegroundProcess.mockResolvedValue('claude')

    await expect(agentWrite('\r')).resolves.toBe(false)
    expect(mocks.provider.write).not.toHaveBeenCalled()
  })

  it('writes a settled write itself once the relay names no shell', async () => {
    mocks.provider.getForegroundProcess.mockResolvedValue('codex')

    await expect(agentWrite('\r', { requireWriteSettlement: true })).resolves.toBe(true)
    expect(mocks.provider.writeWithSettlement).toHaveBeenCalledExactlyOnceWith(id, '\r')
  })
})

describe('guarded payloads elsewhere on the IPC path', () => {
  it('rejects a payload whose guard flag isn’t exactly true', () => {
    const { isPtyWritePayload } = input()

    expect(isPtyWritePayload({ id, data: 'x', requireAgentForeground: true })).toBe(true)
    expect(isPtyWritePayload({ id, data: 'x' })).toBe(true)
    for (const flag of ['true', 1, false, null]) {
      expect(isPtyWritePayload({ id, data: 'x', requireAgentForeground: flag })).toBe(false)
    }
  })

  it('writes nothing for a guarded payload on the plain pty:write path', () => {
    ptyOwnership.set(id, 'local')

    expect(
      input().writePtyInput({ id, data: '\r', inputKind: 'driving', requireAgentForeground: true })
    ).toBe(false)
    expect(mocks.provider.write).not.toHaveBeenCalled()
  })

  it('refuses a guarded write the path didn’t take, and answers an unguarded one false', async () => {
    await expect(
      notTakenWrite({ requireAgentForeground: true }, 'viewport_claim_failed')
    ).rejects.toThrow('agent_not_in_foreground: viewport_claim_failed')
    expect(notTakenWrite({}, 'viewport_claim_failed')).toBe(false)
  })
})
