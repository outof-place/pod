// Fork-only (Pod): the write-time foreground group check.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalForegroundGroup from './terminal-foreground-group'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

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

const { createForegroundGroupWriteGate, pasteThenSubmitWhileGroupHolds } =
  await import('./pod-foreground-group-write-gate')

const ROOT = 100
const SHELL_GROUP = 101
const AGENT_GROUP = 202

function row(pid: number, pgid: number, tpgid: number, command: string): ProcessTableRow {
  return { pid, ppid: 1, pgid, tpgid, stat: 'S', command }
}

/** login → zsh, and claude in its own group when `agentInFront`. */
function rows(agentInFront: boolean): ProcessTableRow[] {
  const front = agentInFront ? AGENT_GROUP : SHELL_GROUP
  return [
    row(ROOT, ROOT, front, 'login -pfl user /bin/zsh'),
    row(SHELL_GROUP, SHELL_GROUP, front, '-zsh'),
    ...(agentInFront ? [row(AGENT_GROUP, AGENT_GROUP, front, 'claude')] : [])
  ]
}

const localPane = {
  foregroundGroupController: () => ({
    listProcesses: async () => [{ id: 'pty-1', rootProcessId: ROOT, cwd: '/tmp', title: 'zsh' }]
  })
}

describe('createForegroundGroupWriteGate', () => {
  beforeEach(() => {
    terminalRows.mockReset()
    groupNow.mockReset()
  })

  it('refuses while the shell holds the terminal, as in the startup bootstrap window', async () => {
    terminalRows.mockResolvedValue(rows(false))
    groupNow.mockReturnValue(SHELL_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, 'claude')

    expect(await gate.prove('pty-1')).toBe('shell')
    expect(gate.holds('pty-1')).toBe(false)
  })

  it('passes a write while the proven agent group still holds the terminal', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, null)

    expect(await gate.prove('pty-1')).toBe('agent')
    expect(gate.holds('pty-1')).toBe(true)
    expect(gate.holds('pty-1')).toBe(true)
  })

  it('refuses a write once the agent exited before it, until a new read proves one', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, 'claude')
    await gate.prove('pty-1')

    groupNow.mockReturnValue(SHELL_GROUP)
    expect(gate.holds('pty-1')).toBe(false)
    groupNow.mockReturnValue(AGENT_GROUP)
    expect(gate.holds('pty-1')).toBe(false)
  })

  it('refuses a write when the group cannot be read now', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, 'claude')
    await gate.prove('pty-1')

    groupNow.mockReturnValue(null)
    expect(gate.holds('pty-1')).toBe(false)
  })

  it('refuses before any proof and when the terminal cannot be read', async () => {
    terminalRows.mockResolvedValue(null)
    const gate = createForegroundGroupWriteGate(localPane, 'claude')

    expect(gate.holds('pty-1')).toBe(false)
    expect(await gate.prove('pty-1')).toBe('unknown')
  })

  it('leaves a pane it cannot read synchronously to its callers (SSH, Windows)', async () => {
    const gate = createForegroundGroupWriteGate({ foregroundGroupController: () => null }, null)

    expect(await gate.prove('pty-1')).toBe('unsupported')
    expect(gate.holds('pty-1')).toBe(true)
    expect(terminalRows).not.toHaveBeenCalled()
  })
})

describe('pasteThenSubmitWhileGroupHolds', () => {
  beforeEach(() => {
    terminalRows.mockReset()
    groupNow.mockReset()
  })

  it('sends the paste, then Enter as its own write', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, null)
    await gate.prove('pty-1')
    const write = vi.fn()

    expect(await pasteThenSubmitWhileGroupHolds(gate, 'pty-1', 'PASTE', write)).toBeNull()
    expect(write.mock.calls).toEqual([['PASTE'], ['\r']])
  })

  it('sends no Enter when the agent left after the paste', async () => {
    terminalRows.mockResolvedValue(rows(true))
    groupNow.mockReturnValue(AGENT_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, null)
    await gate.prove('pty-1')
    const write = vi.fn(() => {
      groupNow.mockReturnValue(SHELL_GROUP)
    })

    expect(await pasteThenSubmitWhileGroupHolds(gate, 'pty-1', 'PASTE', write)).toBe('submit')
    expect(write.mock.calls).toEqual([['PASTE']])
  })

  it('sends nothing when the shell holds the terminal', async () => {
    terminalRows.mockResolvedValue(rows(false))
    groupNow.mockReturnValue(SHELL_GROUP)
    const gate = createForegroundGroupWriteGate(localPane, null)
    await gate.prove('pty-1')
    const write = vi.fn()

    expect(await pasteThenSubmitWhileGroupHolds(gate, 'pty-1', 'PASTE', write)).toBe('paste')
    expect(write).not.toHaveBeenCalled()
  })
})
