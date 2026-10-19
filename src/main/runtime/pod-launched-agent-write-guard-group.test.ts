// Fork-only (Pod): the launch prompt and worker brief guard on a local pane decides by the
// terminal's foreground process group, read again in each write's own synchronous block.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { LaunchedAgentWriteGuardRuntime } from './launched-agent-write-guard'

const terminalRows = vi.fn<() => Promise<ProcessTableRow[] | null>>()
const groupNow = vi.fn<() => number | null>()

vi.mock('./terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: () => terminalRows(),
  terminalOf: async () => 'ttys009'
}))
vi.mock('../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => groupNow()
}))

const { createLaunchedAgentWriteGuard, createWorkerBriefWriteGuard } =
  await import('./launched-agent-write-guard')

const SHELL_GROUP = 101
const AGENT_GROUP = 202

function rows(agentInFront: boolean): ProcessTableRow[] {
  const front = agentInFront ? AGENT_GROUP : SHELL_GROUP
  const row = (pid: number, command: string): ProcessTableRow => ({
    pid,
    ppid: 1,
    pgid: pid,
    tpgid: front,
    stat: 'S',
    command
  })
  return [
    row(100, 'login -pfl user /bin/zsh'),
    row(SHELL_GROUP, '-zsh'),
    ...(agentInFront ? [row(AGENT_GROUP, 'claude')] : [])
  ]
}

function localRuntime(): LaunchedAgentWriteGuardRuntime {
  return {
    // What the tracker answers in its 5 s startup bootstrap: the launch's agent, shell or not.
    readLaunchedAgentForeground: vi.fn(async () => 'agent' as const),
    subscribeToTerminalData: vi.fn(() => () => {}),
    foregroundGroupController: () => ({
      listProcesses: async () => [{ id: 'pty-1', rootProcessId: 100, cwd: '/tmp', title: 'zsh' }]
    })
  }
}

const guards = {
  'launch prompt': (runtime: LaunchedAgentWriteGuardRuntime) =>
    createLaunchedAgentWriteGuard(runtime, 'claude'),
  'worker brief': (runtime: LaunchedAgentWriteGuardRuntime) =>
    createWorkerBriefWriteGuard(runtime, 'claude', true)!
}

describe.each(Object.entries(guards))('the %s guard on a local pane', (_label, create) => {
  beforeEach(() => {
    terminalRows.mockReset()
    groupNow.mockReset()
  })

  it('refuses while the shell still holds the terminal in the startup bootstrap window', async () => {
    terminalRows.mockResolvedValue(rows(false))
    groupNow.mockReturnValue(SHELL_GROUP)
    const runtime = localRuntime()
    const guard = create(runtime)

    await expect(guard.beforeWrite('pty-1')).rejects.toThrow('agent_not_in_foreground')
    expect(() => guard.assertBeforeWrite('pty-1')).toThrow('agent_not_in_foreground')
    expect(runtime.readLaunchedAgentForeground).not.toHaveBeenCalled()
  })

  it('passes each write while the agent group holds the terminal', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const guard = create(localRuntime())

    await guard.beforeWrite('pty-1')
    expect(() => guard.assertBeforeWrite('pty-1')).not.toThrow()
    await guard.beforeWrite('pty-1')
    expect(() => guard.assertBeforeWrite('pty-1')).not.toThrow()
  })

  it('refuses the write when the agent exited after the read', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const guard = create(localRuntime())
    await guard.beforeWrite('pty-1')

    groupNow.mockReturnValue(SHELL_GROUP)
    expect(() => guard.assertBeforeWrite('pty-1')).toThrow('agent_not_in_foreground')
  })
})
