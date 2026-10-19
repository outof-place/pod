// Fork-only (Pod): a guarded write needs a proof that finds the agent in the terminal's foreground
// group, and goes out only while the same group is in front, read again right before it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import type * as TerminalForegroundGroup from '../../runtime/terminal-foreground-group'
import {
  createSendableForegroundFence,
  isTerminalForegroundFenceHeld,
  proveTerminalAgentForeground,
  type TerminalAgentForegroundProof
} from './pod-terminal-foreground-fence'

const mocks = vi.hoisted(
  (): { rows: ProcessTableRow[] | null; tty: string | null; groupNow: number | null } => ({
    rows: null,
    tty: 'ttys007',
    groupNow: null
  })
)

vi.mock('../../runtime/terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  terminalOf: async () => mocks.tty,
  readTerminalProcessRows: async () => mocks.rows
}))
vi.mock('../../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => mocks.groupNow
}))

const ROOT = 100
const SHELL = 101
const AGENT = 200
const controller = {
  listProcesses: async () => [{ id: 'pty-1', rootProcessId: ROOT, cwd: '/tmp', title: 'zsh' }]
}

function terminal(foregroundGroup: number): ProcessTableRow[] {
  return [
    { pid: ROOT, ppid: 1, pgid: ROOT, tpgid: foregroundGroup, stat: 'Ss', command: 'login -pfl u' },
    { pid: SHELL, ppid: ROOT, pgid: SHELL, tpgid: foregroundGroup, stat: 'S', command: '-zsh' },
    { pid: AGENT, ppid: SHELL, pgid: AGENT, tpgid: foregroundGroup, stat: 'S+', command: 'claude' }
  ]
}

beforeEach(() => {
  mocks.rows = null
  mocks.tty = 'ttys007'
  mocks.groupNow = null
})

describe('proveTerminalAgentForeground', () => {
  it('keeps the agent’s foreground group, its root and its terminal', async () => {
    mocks.rows = terminal(AGENT)

    expect(await proveTerminalAgentForeground(controller, 'pty-1', 'claude')).toEqual({
      verdict: 'agent',
      fence: { rootPid: ROOT, tty: 'ttys007', foregroundGroup: AGENT }
    })
    expect((await proveTerminalAgentForeground(controller, 'pty-1', null)).verdict).toBe('agent')
  })

  it('finds the shell when the shell holds the terminal, with or without a named agent', async () => {
    mocks.rows = terminal(SHELL)

    expect(await proveTerminalAgentForeground(controller, 'pty-1', 'claude')).toEqual({
      verdict: 'shell'
    })
    expect(await proveTerminalAgentForeground(controller, 'pty-1', null)).toEqual({
      verdict: 'shell'
    })
  })

  it.each([
    ['the pane is not listed', () => ({ listProcesses: async () => [] })],
    ['the terminal is gone', () => ((mocks.tty = null), controller)],
    ['no rows answer', () => controller],
    ['no group holds the terminal', () => ((mocks.rows = terminal(-1)), controller)]
  ])('cannot tell when %s', async (_what, setup) => {
    expect(await proveTerminalAgentForeground(setup(), 'pty-1', 'claude')).toEqual({
      verdict: 'unknown'
    })
  })
})

describe('the fence', () => {
  const fence = { rootPid: ROOT, tty: 'ttys007', foregroundGroup: AGENT }

  it('holds only while the same group is in front, read now', () => {
    mocks.groupNow = AGENT
    expect(isTerminalForegroundFenceHeld(fence)).toBe(true)
    mocks.groupNow = SHELL
    expect(isTerminalForegroundFenceHeld(fence)).toBe(false)
    mocks.groupNow = null
    expect(isTerminalForegroundFenceHeld(fence)).toBe(false)
  })
})

describe("terminal.send's sendable fence", () => {
  function prover(proof: TerminalAgentForegroundProof | null) {
    return { proveTerminalAgentForegroundFence: vi.fn(async () => proof) }
  }
  const agentProof: TerminalAgentForegroundProof = {
    verdict: 'agent',
    fence: { rootPid: ROOT, tty: 'ttys007', foregroundGroup: AGENT }
  }

  it('lets a write through while the agent stays in front, and refuses one after it left', async () => {
    const send = createSendableForegroundFence(prover(agentProof))
    await send.prove('pty-1')

    mocks.groupNow = AGENT
    expect(() => send.atWrite('pty-1')).not.toThrow()
    mocks.groupNow = SHELL
    expect(() => send.atWrite('pty-1')).toThrow('terminal_guard_no_agent')
  })

  it.each(['shell', 'unknown'] as const)(
    'refuses before any write when the proof finds %s',
    async (verdict) => {
      const send = createSendableForegroundFence(prover({ verdict }))

      await expect(send.prove('pty-1')).rejects.toThrow('terminal_guard_no_agent')
      expect(() => send.atWrite('pty-1')).toThrow('terminal_guard_no_agent')
    }
  )

  it('refuses a write no proof came before', () => {
    const send = createSendableForegroundFence(prover(agentProof))
    mocks.groupNow = AGENT

    expect(() => send.atWrite('pty-1')).toThrow('terminal_guard_no_agent')
  })

  it('leaves an SSH or Windows pane to its async guard', async () => {
    const send = createSendableForegroundFence(prover(null))
    await send.prove('pty-1')

    expect(() => send.atWrite('pty-1')).not.toThrow()
  })
})
