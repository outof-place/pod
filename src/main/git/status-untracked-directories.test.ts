import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { clearEffectiveUpstreamStatusCacheForTests, getStatus } from './status'

const LISTING_ARGS_PREFIX = [
  'ls-files',
  '-z',
  '--others',
  '--exclude-standard',
  '--full-name',
  '--'
]

describe('getStatus untracked directory expansion', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitStreamOptionsMock.mockReset()
    readFileMock.mockReset()
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    statMock.mockReset()
    statMock.mockResolvedValue({ isFile: () => true, size: 12 })
  })

  it('lists every file under a collapsed untracked directory, as untracked=all did', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return { stdout: '? new/\n? top.txt\n' }
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'new/a.ts\0new/deep/b.ts\0' }
      }
      return { stdout: '' }
    })

    const result = await getStatus('/repo', { includeLineStats: false })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith([
      ...LISTING_ARGS_PREFIX,
      ':(top,literal)new/'
    ])
    expect(result.entries).toEqual([
      { path: 'new/a.ts', status: 'untracked', area: 'untracked' },
      { path: 'new/deep/b.ts', status: 'untracked', area: 'untracked' },
      { path: 'top.txt', status: 'untracked', area: 'untracked' }
    ])
    // Why: the listing is a read, so it must not race terminal Git on index.lock either.
    for (const [options] of gitStreamOptionsMock.mock.calls) {
      expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0')
    }
  })

  it('caps expanded rows at the status limit and reports the overflow', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return { stdout: '? huge/\n' }
      }
      if (args[0] === 'ls-files') {
        return {
          stdout: Array.from({ length: 50 }, (_, index) => `huge/${index}.txt\0`).join('')
        }
      }
      return { stdout: '' }
    })

    const result = await getStatus('/repo', { limit: 10 })

    expect(result.didHitLimit).toBe(true)
    expect(result.statusLength).toBe(11)
    expect(result.entries).toHaveLength(10)
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args.includes('diff'))).toBe(false)
  })

  it('keeps the collapsed row when the listing fails after status succeeded', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('status')) {
        return { stdout: '? new/\n' }
      }
      if (args[0] === 'ls-files') {
        throw new Error('fatal: transient failure')
      }
      return { stdout: '' }
    })

    const result = await getStatus('/repo', { includeLineStats: false })

    expect(result.entries).toEqual([{ path: 'new/', status: 'untracked', area: 'untracked' }])
  })

  it('keeps untracked=all when ignored paths are requested', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '? new/a.ts\n! new/x.log\n' })

    const result = await getStatus('/repo', { includeIgnored: true, includeLineStats: false })

    expect(gitExecFileAsyncMock.mock.calls[0][0]).toContain('--untracked-files=all')
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'ls-files')).toBe(false)
    expect(result.ignoredPaths).toEqual(['new/x.log'])
  })
})
