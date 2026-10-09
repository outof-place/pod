import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setNativeProcessInfoForTests,
  type NativeProcessRow,
  type NativeTerminalProcessRow
} from '../../shared/native-process-info'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { judgeTerminalForeground, readTerminalProcessRows } from './terminal-foreground-group'

function row(pid: number, fields: Partial<NativeTerminalProcessRow>): NativeTerminalProcessRow {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    tpgid: 300,
    stat: 'S',
    tty: 'ttys003',
    startTime: 'Thu Sep  3 16:02:05 2026',
    command: null,
    name: 'unknown',
    ...fields
  }
}

/** A macOS pane: root-owned login (argv unreadable as the user), the shell, and an agent. */
function installPane(rootPid: number, agentArgv: string | null): void {
  const rows = [
    row(rootPid, { name: 'login' }),
    row(rootPid + 1, { ppid: rootPid, stat: 'Ss', command: '-zsh', name: 'zsh' }),
    row(300, { ppid: rootPid + 1, stat: 'S+', command: agentArgv, name: 'claude' })
  ]
  setNativeProcessInfoForTests({
    listProcesses: () => rows,
    readProcess: (pid): NativeProcessRow | null =>
      rows.find((candidate) => candidate.pid === pid) ?? null,
    listTerminalProcesses: (tty) => (tty === 'ttys003' ? rows : null),
    readProcessCwd: () => null
  })
}

describe('readTerminalProcessRows with the native process-info addon', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
  })

  afterEach(() => {
    setNativeProcessInfoForTests(undefined)
  })

  it('reads the pane terminal and its argv without forking ps', async () => {
    installPane(100, '/opt/bin/claude --resume')

    const rows = await readTerminalProcessRows(100)

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(rows?.map(({ pid, command }) => [pid, command])).toEqual([
      // Outside the foreground group, so the kernel's short name is all the verdict needs.
      [100, 'login'],
      [101, '-zsh'],
      [300, '/opt/bin/claude --resume']
    ])
    expect(judgeTerminalForeground(rows!, 100, 'claude')).toBe('agent')
  })

  it('asks ps when a foreground-group member belongs to another user', async () => {
    installPane(110, null)
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: [
        '110 1 110 300 Ss /usr/bin/login -flpq user /bin/zsh',
        '111 110 111 300 Ss -zsh',
        '300 111 300 300 S+ /opt/bin/claude'
      ].join('\n'),
      stderr: '',
      timedOut: false
    })

    const rows = await readTerminalProcessRows(110)

    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'ps',
        args: ['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', 'ttys003']
      })
    )
    expect(rows?.find((candidate) => candidate.pid === 300)?.command).toBe('/opt/bin/claude')
  })

  it('treats a vanished root as no terminal rather than asking ps', async () => {
    installPane(120, '/opt/bin/claude')

    await expect(readTerminalProcessRows(999)).resolves.toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
