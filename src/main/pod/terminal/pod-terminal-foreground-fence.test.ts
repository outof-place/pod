// Fork-only (Pod): a guarded write needs a proof that finds the agent in the terminal's foreground
// group, and goes out only while the same group is in front, read again right before it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import {
  TUI_AGENT_CONFIG,
  getTuiAgentLaunchCommand,
  isTuiAgent
} from '../../../shared/tui-agent-config'
import { YOLO_TUI_AGENT_ARGS } from '../../../shared/tui-agent-permissions'
import type * as TerminalForegroundGroup from '../../runtime/terminal-foreground-group'
import {
  assertTerminalForegroundFence,
  createSendableForegroundFence,
  isTerminalForegroundFenceHeld,
  proveTerminalAgentForeground,
  proveTerminalAgentForegroundOnHost,
  writeIfForegroundSync,
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
vi.mock('./pod-terminal-foreground-read', () => ({
  readTerminalForegroundGroupNow: () =>
    mocks.groupNow === null
      ? { ok: false, reason: 'read_failed' }
      : { ok: true, group: mocks.groupNow }
}))

const ROOT = 100
const ALL_AGENTS = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
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
  // The local provider lists its own node-pty; the daemon's inventory lists sessions it holds, those
  // started before Pod restarted included. Both name the root the same way.
  it.each([
    ['a local PTY', { id: 'pty-1', rootProcessId: ROOT, cwd: '/tmp', title: 'zsh' }],
    [
      'a daemon session',
      {
        id: 'pty-1',
        incarnationId: 'inc-1',
        rootProcessId: ROOT,
        cwd: '/tmp',
        title: 'shell',
        worktreeId: 'wt-1'
      }
    ]
  ])('proves the agent the same way for %s', async (_what, pane) => {
    mocks.rows = terminal(AGENT)

    expect(
      await proveTerminalAgentForeground({ listProcesses: async () => [pane] }, 'pty-1', 'claude')
    ).toMatchObject({ verdict: 'agent', fence: { foregroundGroup: AGENT } })
  })

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

  // Not a shell, and not an agent either: a note or Enter there runs as a command.
  it.each([
    ['ssh to another host', ['ssh build-host']],
    ['sudo -s with its root shell', ['sudo -s', '/bin/bash']],
    ['a Python REPL', ['python3']],
    ['psql', ['psql app']],
    ['another agent than the one named', ['codex']]
  ])('refuses when %s holds the terminal', async (_what, commands) => {
    mocks.rows = [
      ...terminal(SHELL).slice(0, 2),
      ...commands.map((command, index) => ({
        pid: 300 + index,
        ppid: SHELL,
        pgid: 300,
        tpgid: 300,
        stat: 'S+',
        command
      }))
    ].map((row) => ({ ...row, tpgid: 300 }))

    expect(await proveTerminalAgentForeground(controller, 'pty-1', 'claude')).toEqual({
      verdict: 'not_agent'
    })
    if (commands[0] !== 'codex') {
      expect(await proveTerminalAgentForeground(controller, 'pty-1', null)).toEqual({
        verdict: 'not_agent'
      })
    }
  })

  it('finds the agent behind an interpreter and by name when none is named', async () => {
    mocks.rows = [
      ...terminal(SHELL).slice(0, 2),
      {
        pid: 400,
        ppid: SHELL,
        pgid: 400,
        tpgid: 400,
        stat: 'S+',
        command: '/bin/sh /tmp/x/bin/claude'
      }
    ].map((row) => ({ ...row, tpgid: 400 }))

    expect((await proveTerminalAgentForeground(controller, 'pty-1', null)).verdict).toBe('agent')
    expect((await proveTerminalAgentForeground(controller, 'pty-1', 'claude')).verdict).toBe(
      'agent'
    )
  })

  // The judge needs a recognized agent now, where a named launch once passed as anything not a
  // shell: every agent's own launch line must still read as that agent, or its prompt never goes.
  it.each(ALL_AGENTS)('finds %s by the launch line Pod types for it', async (agent) => {
    const launch = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], 'darwin')
    const yolo = YOLO_TUI_AGENT_ARGS[agent]
    const command = yolo ? `${launch} ${yolo}` : launch
    mocks.rows = [
      ...terminal(SHELL).slice(0, 2),
      { pid: 500, ppid: SHELL, pgid: 500, tpgid: 500, stat: 'S+', command }
    ].map((row) => ({ ...row, tpgid: 500 }))

    expect((await proveTerminalAgentForeground(controller, 'pty-1', agent)).verdict).toBe('agent')
    expect((await proveTerminalAgentForeground(controller, 'pty-1', null)).verdict).toBe('agent')
  })

  // What the running agent reports as its process, where that differs from the line typed.
  it.each(ALL_AGENTS)('finds %s by the process it runs as', async (agent) => {
    const command = `/usr/local/bin/${TUI_AGENT_CONFIG[agent].expectedProcess}`
    mocks.rows = [
      ...terminal(SHELL).slice(0, 2),
      { pid: 500, ppid: SHELL, pgid: 500, tpgid: 500, stat: 'S+', command }
    ].map((row) => ({ ...row, tpgid: 500 }))

    expect((await proveTerminalAgentForeground(controller, 'pty-1', agent)).verdict).toBe('agent')
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

describe('the proof on an SSH or Windows pane', () => {
  const SSH = { remote: true, windows: false }
  function relay(name: string | null | Error) {
    return {
      getForegroundProcess: vi.fn(async () => {
        if (name instanceof Error) {
          throw name
        }
        return name
      })
    }
  }

  it.each(['-zsh', 'zsh', 'bash', '/bin/sh'])(
    'proves the shell its relay names in front (%s), when asked',
    async (name) => {
      expect(
        await proveTerminalAgentForegroundOnHost(relay(name), SSH, 'pty-1', null, true)
      ).toEqual({ verdict: 'shell' })
    }
  )

  it.each([
    ['an agent', 'claude'],
    ['a process that is not a shell', 'vim'],
    ['no name', null],
    ['a failed read', new Error('relay gone')]
  ])('leaves %s in front unproven: the async guard decides', async (_what, name) => {
    expect(await proveTerminalAgentForegroundOnHost(relay(name), SSH, 'pty-1', null, true)).toBe(
      null
    )
  })

  it('asks no relay unless asked, and never on Windows', async () => {
    const ssh = relay('-zsh')
    const windows = relay('-zsh')

    expect(await proveTerminalAgentForegroundOnHost(ssh, SSH, 'pty-1', null)).toBe(null)
    expect(
      await proveTerminalAgentForegroundOnHost(
        windows,
        { remote: true, windows: true },
        'pty-1',
        null,
        true
      )
    ).toBe(null)
    expect(ssh.getForegroundProcess).not.toHaveBeenCalled()
    expect(windows.getForegroundProcess).not.toHaveBeenCalled()
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

  it('names why it refused: another group in front, or a read that failed', () => {
    mocks.groupNow = SHELL
    expect(() => assertTerminalForegroundFence(fence)).toThrow(
      'agent_not_in_foreground: group_changed'
    )
    mocks.groupNow = null
    expect(() => assertTerminalForegroundFence(fence)).toThrow(
      'agent_not_in_foreground: read_failed'
    )
  })

  it('writes only after the check passes, and not at all when it throws', () => {
    const write = vi.fn(() => true)
    mocks.groupNow = AGENT
    const check = (): void => assertTerminalForegroundFence(fence)

    expect(writeIfForegroundSync(check, 'pty-1', write)).toBe(true)
    mocks.groupNow = SHELL
    expect(() => writeIfForegroundSync(check, 'pty-1', write)).toThrow('group_changed')
    expect(write).toHaveBeenCalledOnce()
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

  it.each(['shell', 'not_agent', 'unknown'] as const)(
    'refuses before any write when the proof finds %s, and says so',
    async (verdict) => {
      const send = createSendableForegroundFence(prover({ verdict }))

      await expect(send.prove('pty-1')).rejects.toThrow(`terminal_guard_no_agent: ${verdict}`)
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
