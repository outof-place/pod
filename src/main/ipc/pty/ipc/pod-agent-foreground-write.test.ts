// Fork-only (Pod): main lands a renderer agent write only while an agent holds the terminal.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalForegroundGroup from '../../../runtime/terminal-foreground-group'
import type { ProcessTableRow } from '../../../../shared/process-table-snapshot'

const terminalRows = vi.fn<() => Promise<ProcessTableRow[] | null>>()
const groupNow = vi.fn<() => number | null>()

vi.mock('../../../runtime/terminal-foreground-group', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalForegroundGroup>()),
  readTerminalProcessRows: () => terminalRows(),
  terminalOf: async () => 'ttys009'
}))
vi.mock('../../../pty/posix-pty-foreground-group', () => ({
  readPosixPtyForegroundGroup: () => groupNow()
}))

const { writeWhileAgentInFront } = await import('./pod-agent-foreground-write')

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
    ...(agentInFront ? [row(AGENT_GROUP, 'aider')] : [])
  ]
}

const localPane = {
  foregroundGroupController: () => ({
    listProcesses: async () => [{ id: 'pty-1', rootProcessId: 100, cwd: '/tmp', title: 'zsh' }]
  })
}

describe('writeWhileAgentInFront', () => {
  beforeEach(() => {
    terminalRows.mockReset()
    groupNow.mockReset()
  })

  it('refuses while the shell holds the terminal, as in the startup bootstrap window', async () => {
    terminalRows.mockResolvedValue(rows(false))
    groupNow.mockReturnValue(SHELL_GROUP)
    const write = vi.fn(() => true)

    await expect(writeWhileAgentInFront(localPane, 'pty-1', write)).rejects.toThrow(
      'agent_not_in_foreground'
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('writes while the agent holds the terminal', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const write = vi.fn(() => true)

    await expect(writeWhileAgentInFront(localPane, 'pty-1', write)).resolves.toBe(true)
    expect(write).toHaveBeenCalledOnce()
  })

  it('refuses when the agent exited between the read and the write', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(SHELL_GROUP)
    const write = vi.fn(() => true)

    await expect(writeWhileAgentInFront(localPane, 'pty-1', write)).rejects.toThrow(
      'agent_not_in_foreground'
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('writes as before on a pane it cannot read', async () => {
    const write = vi.fn(() => true)

    await expect(
      writeWhileAgentInFront({ foregroundGroupController: () => null }, 'pty-1', write)
    ).resolves.toBe(true)
    expect(terminalRows).not.toHaveBeenCalled()
  })
})
