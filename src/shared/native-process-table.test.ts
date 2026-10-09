import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setNativeProcessInfoForTests, type NativeTerminalProcessRow } from './native-process-info'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { readNativeFullProcessTable } from './native-process-table'
import {
  getFreshShellForegroundSnapshot,
  getStrictProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'

function row(pid: number, fields: Partial<NativeTerminalProcessRow>): NativeTerminalProcessRow {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    tpgid: 0,
    stat: 'S',
    tty: '??',
    startTime: 'Thu Sep  3 16:02:05 2026',
    command: null,
    name: 'unknown',
    ...fields
  }
}

function installNative(rows: () => NativeTerminalProcessRow[]): void {
  setNativeProcessInfoForTests({
    listProcesses: () => [],
    listProcessesWithCommands: rows,
    readProcess: () => null,
    listTerminalProcesses: () => null,
    readProcessCwd: () => null
  })
}

/** A macOS pane: root-owned login (argv withheld), the user's shell, and an agent. */
const pane = [
  row(1, { ppid: 0, path: '/sbin/launchd', name: 'launchd' }),
  row(100, { tty: 'ttys003', tpgid: 300, stat: 'Ss', path: '/usr/bin/login', name: 'login' }),
  row(101, { ppid: 100, tty: 'ttys003', tpgid: 300, stat: 'Ss', command: '-zsh', name: 'zsh' }),
  row(300, {
    ppid: 101,
    tty: 'ttys003',
    tpgid: 300,
    stat: 'S+',
    command: '/opt/bin/claude',
    name: 'claude'
  })
]

afterEach(() => {
  setNativeProcessInfoForTests(undefined)
})

describe('readNativeFullProcessTable', () => {
  it('names a withheld-argv process by its executable when its argv cannot change a verdict', () => {
    installNative(() => [...pane, row(560, { name: 'unbound' })])

    expect(
      readNativeFullProcessTable()?.map(({ pid, tty, command }) => [pid, tty, command])
    ).toEqual([
      [1, '??', '/sbin/launchd'],
      // login never reads as a shell or an agent, so its path is all any verdict needs.
      [100, 'ttys003', '/usr/bin/login'],
      [101, 'ttys003', '-zsh'],
      [300, 'ttys003', '/opt/bin/claude'],
      // A daemon whose path the kernel also withholds keeps ps's own placeholder.
      [560, '??', '(unbound)']
    ])
  })

  it.each([
    ['an interpreter whose script names the program', '/bin/bash'],
    ['an agent whose flags decide what it is', '/opt/bin/claude'],
    ['a process whose executable the kernel also withholds', undefined]
  ])('defers to ps when a terminal holder is %s', (_label, path) => {
    installNative(() => [
      ...pane,
      row(400, { ppid: 101, tty: 'ttys003', tpgid: 300, path, name: 'sudo-child' })
    ])

    expect(readNativeFullProcessTable()).toBeNull()
  })

  it('ignores withheld argv on processes that hold no terminal', () => {
    installNative(() => [row(42, { path: '/usr/bin/python3', name: 'python3' })])

    expect(readNativeFullProcessTable()).toEqual([
      {
        pid: 42,
        ppid: 1,
        pgid: 42,
        tpgid: 0,
        stat: 'S',
        tty: '??',
        startTime: 'Thu Sep  3 16:02:05 2026',
        command: '/usr/bin/python3'
      }
    ])
  })

  it('returns null when the addon throws or is absent', () => {
    installNative(() => {
      throw new Error('sysctl(KERN_PROC_ALL) failed: Cannot allocate memory')
    })
    expect(readNativeFullProcessTable()).toBeNull()
    setNativeProcessInfoForTests(null)
    expect(readNativeFullProcessTable()).toBeNull()
  })
})

describe('full and shell-foreground captures with the native process-info addon', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
  })

  it('serves both tiers from sysctl without forking ps', async () => {
    installNative(() => pane)

    const strict = await getStrictProcessTableSnapshot()
    const shell = await getFreshShellForegroundSnapshot()

    expect(strict.find((candidate) => candidate.pid === 100)).toMatchObject({
      tty: 'ttys003',
      startTime: 'Thu Sep  3 16:02:05 2026',
      command: '/usr/bin/login'
    })
    expect(shell.find((candidate) => candidate.pid === 300)).toEqual({
      pid: 300,
      ppid: 101,
      pgid: 300,
      tpgid: 300,
      stat: 'S+',
      command: '/opt/bin/claude'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('falls back to ps when a terminal holder needs root to be named', async () => {
    installNative(() => [
      ...pane,
      row(400, { ppid: 101, tty: 'ttys003', tpgid: 300, path: '/usr/bin/python3' })
    ])
    execFileMock.mockImplementation((_program, _args, _options, callback) => {
      callback(null, { stdout: '100 99 100 100 Ss+ /bin/zsh -l', stderr: '' })
    })

    await expect(getFreshShellForegroundSnapshot()).resolves.toEqual([
      { pid: 100, ppid: 99, pgid: 100, tpgid: 100, stat: 'Ss+', command: '/bin/zsh -l' }
    ])
    expect(execFileMock).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,command='],
      expect.anything(),
      expect.any(Function)
    )
  })
})
