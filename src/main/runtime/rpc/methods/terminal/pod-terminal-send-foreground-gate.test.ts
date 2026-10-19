// Fork-only (Pod): terminal.send's guarded writes check the terminal's foreground process group.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalForegroundGroup from '../../../terminal-foreground-group'
import type { ProcessTableRow } from '../../../../../shared/process-table-snapshot'

const terminalRows = vi.fn<() => Promise<ProcessTableRow[] | null>>()
const groupNow = vi.fn<() => number | null>()

vi.mock('../../../terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: () => terminalRows(),
  terminalOf: async () => 'ttys009'
}))
vi.mock('../../../../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => groupNow()
}))

const { createTerminalSendForegroundGate } = await import('./pod-terminal-send-foreground-gate')

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
    ...(agentInFront ? [row(AGENT_GROUP, 'codex')] : [])
  ]
}

const localRuntime = {
  foregroundGroupController: () => ({
    listProcesses: async () => [{ id: 'pty-1', rootProcessId: 100, cwd: '/tmp', title: 'zsh' }]
  })
}

describe('terminal.send foreground gate', () => {
  beforeEach(() => {
    terminalRows.mockReset()
    groupNow.mockReset()
  })

  it('refuses while the shell holds the terminal, whatever the agent status said', async () => {
    terminalRows.mockResolvedValue(rows(false))
    groupNow.mockReturnValue(SHELL_GROUP)
    const statusSaysAgent = vi.fn(async () => {})
    const gate = createTerminalSendForegroundGate(localRuntime)

    await expect(gate.withProof(statusSaysAgent)('pty-1')).rejects.toThrow(
      'terminal_guard_no_agent'
    )
    expect(statusSaysAgent).toHaveBeenCalledWith('pty-1')
    expect(() => gate.assertBeforeWrite('pty-1')).toThrow('terminal_guard_no_agent')
  })

  it('passes while the agent group holds the terminal', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createTerminalSendForegroundGate(localRuntime)

    await gate.withProof()('pty-1')
    expect(() => gate.assertBeforeWrite('pty-1')).not.toThrow()
  })

  it('refuses the write when the agent exited after the proof', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createTerminalSendForegroundGate(localRuntime)
    await gate.withProof()('pty-1')

    groupNow.mockReturnValue(SHELL_GROUP)
    expect(() => gate.assertBeforeWrite('pty-1')).toThrow('terminal_guard_no_agent')
  })

  it('leaves an SSH or Windows pane to the agent status check', async () => {
    const gate = createTerminalSendForegroundGate({ foregroundGroupController: () => null })

    await gate.withProof()('pty-1')
    expect(() => gate.assertBeforeWrite('pty-1')).not.toThrow()
    expect(terminalRows).not.toHaveBeenCalled()
  })
})
