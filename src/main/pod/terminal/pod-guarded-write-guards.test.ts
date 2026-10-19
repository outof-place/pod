// Fork-only (Pod): every guard of an agent write keeps the proof's foreground group and re-reads it
// in the write's own block: the launch prompt's guard, a worker brief's, and terminal.send's
// `sendable`. A read the tracker's 5 s startup guess would pass, or a reuse of an earlier read, never
// lets a write through once the group in front is not the agent's.
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLaunchedAgentWriteGuard,
  createWorkerBriefWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../runtime/rpc/methods/terminal'
import type { TerminalAgentForegroundProof } from './pod-terminal-foreground-fence'

const fence = vi.hoisted((): { groupNow: number | null } => ({ groupNow: null }))
vi.mock('../../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => fence.groupNow
}))

const AGENT_GROUP = 200
const SHELL_GROUP = 101
const AGENT_PROOF: TerminalAgentForegroundProof = {
  verdict: 'agent',
  fence: { rootPid: 100, tty: 'ttys007', foregroundGroup: AGENT_GROUP }
}

afterEach(() => {
  fence.groupNow = null
  vi.useRealTimers()
})

function guardRuntime(proof: TerminalAgentForegroundProof) {
  let listener: ((data: string) => void) | null = null
  const runtime: LaunchedAgentWriteGuardRuntime = {
    // What the tracker's startup guess or an earlier read would say: the agent.
    readLaunchedAgentForeground: vi.fn(async () => 'agent' as const),
    subscribeToTerminalData: vi.fn((_ptyId: string, next: (data: string) => void) => {
      listener = next
      return () => {
        listener = null
      }
    }),
    proveTerminalAgentForegroundFence: vi.fn(async () => proof)
  }
  return { runtime, emit: (data: string) => listener?.(data) }
}

describe("the launch prompt's guard", () => {
  it('lets each write through while the agent’s group stays in front', async () => {
    const { runtime } = guardRuntime(AGENT_PROOF)
    const guard = createLaunchedAgentWriteGuard(runtime, 'claude')
    fence.groupNow = AGENT_GROUP

    await guard.beforeWrite('pty-1')
    expect(() => guard.atWrite('pty-1')).not.toThrow()
    // Enter and Codex's second Enter reuse the read, and are checked again at their writes.
    await guard.beforeWrite('pty-1')
    expect(() => guard.atWrite('pty-1')).not.toThrow()
    expect(runtime.proveTerminalAgentForegroundFence).toHaveBeenCalledTimes(1)
  })

  it('refuses the Enter after the paste once the agent left, though the read is reused', async () => {
    const { runtime } = guardRuntime(AGENT_PROOF)
    const guard = createLaunchedAgentWriteGuard(runtime, 'claude')
    fence.groupNow = AGENT_GROUP
    await guard.beforeWrite('pty-1')
    guard.atWrite('pty-1')

    fence.groupNow = SHELL_GROUP
    await guard.beforeWrite('pty-1')

    expect(() => guard.atWrite('pty-1')).toThrow('agent_not_in_foreground')
  })

  it('refuses while a shell holds the terminal, whatever the startup guess says', async () => {
    const { runtime } = guardRuntime({ verdict: 'shell' })
    const guard = createLaunchedAgentWriteGuard(runtime, 'claude')

    await expect(guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
    expect(runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
  })

  it('refuses a write no read came before', () => {
    const { runtime } = guardRuntime(AGENT_PROOF)
    fence.groupNow = AGENT_GROUP

    expect(() => createLaunchedAgentWriteGuard(runtime, 'claude').atWrite('pty-1')).toThrow(
      'agent_not_in_foreground'
    )
  })

  it('guards a worker brief the same way', async () => {
    const { runtime } = guardRuntime(AGENT_PROOF)
    const guard = createWorkerBriefWriteGuard(runtime, 'claude', true)!
    fence.groupNow = AGENT_GROUP
    await guard.beforeWrite('pty-1')

    fence.groupNow = SHELL_GROUP
    expect(() => guard.atWrite('pty-1')).toThrow('agent_not_in_foreground')
  })
})

describe("terminal.send's sendable guard", () => {
  function sendRuntime(proof: TerminalAgentForegroundProof, flipAfterProof = false) {
    const written: string[] = []
    const prove = vi.fn(async () => {
      fence.groupNow = flipAfterProof ? SHELL_GROUP : AGENT_GROUP
      return proof
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      // The status the tracker's startup guess gives: an agent at work.
      getTerminalAgentStatus: vi
        .fn()
        .mockResolvedValue({ handle: 'terminal-1', isRunningAgent: true, status: 'working' }),
      proveTerminalAgentForegroundFence: prove,
      sendTerminal: vi.fn(async (_handle, action, options) => {
        await options.beforeWrite('pty-1')
        options.atWrite('pty-1')
        written.push(action.text)
        return { handle: 'terminal-1', accepted: true, bytesWritten: action.text.length }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.send calls only these members.
    return { runtime: runtime as unknown as OrcaRuntimeService, written, prove }
  }

  function send(runtime: OrcaRuntimeService) {
    return new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: 'a note for the agent',
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      }
    })
  }

  it('sends a note to the agent in front', async () => {
    const h = sendRuntime(AGENT_PROOF)

    await expect(send(h.runtime)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(h.written).toEqual(['a note for the agent'])
  })

  it('writes zero bytes when a shell holds the terminal, though the status says agent', async () => {
    const h = sendRuntime({ verdict: 'shell' })

    await expect(send(h.runtime)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0, refusedReason: 'no-agent' } }
    })
    expect(h.written).toEqual([])
  })

  it('writes zero bytes when the agent left between the proof and the write', async () => {
    const h = sendRuntime(AGENT_PROOF, true)

    await expect(send(h.runtime)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0, refusedReason: 'no-agent' } }
    })
    expect(h.written).toEqual([])
  })
})
