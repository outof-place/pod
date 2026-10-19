// Fork-only (Pod): the fence's synchronous read: native proc-info with the tty pinned in every
// build, /bin/ps under LC_ALL=C only in a development build without the addon, and a typed refusal
// for everything else.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeProcessForegroundRow } from '../../../shared/native-process-info'
import { readTerminalForegroundGroupNow } from './pod-terminal-foreground-read'

type Native = { readProcessForegroundGroup: () => NativeProcessForegroundRow | null }
const mocks = vi.hoisted(
  (): {
    native: Native | null
    packaged: boolean | null
    ps: string | Error
    runProcessSync: ReturnType<typeof vi.fn>
  } => ({ native: null, packaged: null, ps: '', runProcessSync: vi.fn() })
)

vi.mock('../../../shared/native-process-info', () => ({ getNativeProcessInfo: () => mocks.native }))
vi.mock('../../../shared/app-environment', () => ({
  hasAppEnvironment: () => mocks.packaged !== null,
  getAppEnvironment: () => ({ isPackaged: () => mocks.packaged === true })
}))
vi.mock('@orca/process-host', () => ({ runProcessSync: mocks.runProcessSync }))

function psExit(stdout: string, code = 0) {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

function native(row: NativeProcessForegroundRow | null | Error): Native {
  return {
    readProcessForegroundGroup: () => {
      if (row instanceof Error) {
        throw row
      }
      return row
    }
  }
}

afterEach(() => {
  mocks.native = null
  mocks.packaged = null
  mocks.runProcessSync.mockReset()
})

describe('readTerminalForegroundGroupNow', () => {
  it.each([
    ['the group in front', { pid: 100, tpgid: 200, tty: 'ttys007' }, { ok: true, group: 200 }],
    [
      'a root on another terminal',
      { pid: 100, tpgid: 200, tty: '??' },
      { ok: false, reason: 'other_tty' }
    ],
    ['a root that is gone', null, { ok: false, reason: 'root_gone' }],
    [
      'no group in front',
      { pid: 100, tpgid: -1, tty: 'ttys007' },
      { ok: false, reason: 'no_foreground_group' }
    ],
    ['a read that throws', new Error('sysctl'), { ok: false, reason: 'read_failed' }]
  ] as const)('reads %s from native proc-info', (_what, row, read) => {
    mocks.native = native(row)
    mocks.packaged = true

    expect(readTerminalForegroundGroupNow(100, '/dev/ttys007')).toEqual(read)
    expect(mocks.runProcessSync).not.toHaveBeenCalled()
  })

  it.each([
    ['a packaged build', true],
    ['a host with no app environment', null]
  ])('refuses without the addon in %s, and runs no ps', (_what, packaged) => {
    mocks.packaged = packaged

    expect(readTerminalForegroundGroupNow(100, 'ttys007')).toEqual({
      ok: false,
      reason: 'reader_unavailable'
    })
    expect(mocks.runProcessSync).not.toHaveBeenCalled()
  })

  it('falls back to /bin/ps under LC_ALL=C in a development build without the addon', () => {
    mocks.packaged = false
    mocks.runProcessSync.mockReturnValue(psExit('  100   200 ttys007\n'))

    expect(readTerminalForegroundGroupNow(100, 'ttys007')).toEqual({ ok: true, group: 200 })
    expect(mocks.runProcessSync).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/ps',
        args: ['-p', '100', '-o', 'pid=,tpgid=,tty='],
        env: { LC_ALL: 'C' }
      })
    )
  })

  it('refuses when ps fails, times out, can not start or names another terminal', () => {
    mocks.packaged = false
    mocks.runProcessSync
      .mockReturnValueOnce(psExit('', 1))
      .mockReturnValueOnce({ ...psExit(''), code: null, signal: 'SIGTERM', timedOut: true })
      .mockImplementationOnce(() => {
        throw new Error('spawn ENOENT')
      })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(readTerminalForegroundGroupNow(100, 'ttys007')).toEqual({
        ok: false,
        reason: 'read_failed'
      })
    }
    mocks.runProcessSync.mockReturnValueOnce(psExit('  100   200 ttys009\n'))
    expect(readTerminalForegroundGroupNow(100, 'ttys007')).toEqual({
      ok: false,
      reason: 'other_tty'
    })
  })
})
