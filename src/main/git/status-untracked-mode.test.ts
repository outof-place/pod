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

import {
  clearEffectiveUpstreamStatusCacheForTests,
  getStatus,
  invalidateGitReadCaches
} from './status'

describe('getStatus adaptive untracked mode', () => {
  beforeEach(() => {
    clearEffectiveUpstreamStatusCacheForTests()
    invalidateGitReadCaches()
    gitExecFileAsyncMock.mockReset()
    gitStreamOptionsMock.mockReset()
    readFileMock.mockReset()
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    statMock.mockReset()
    statMock.mockResolvedValue({ isFile: () => true, size: 12 })
  })

  it('uses one canonical status for directory-heavy scans', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '? new/a.ts\n? new/deep/b.ts\n? top.txt\n' })
    const first = await getStatus('/repo', { includeLineStats: false })
    const second = await getStatus('/repo', { includeLineStats: false })
    expect(first.entries.map((entry) => entry.path)).toEqual([
      'new/a.ts',
      'new/deep/b.ts',
      'top.txt'
    ])
    expect(second.entries).toEqual(first.entries)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      gitExecFileAsyncMock.mock.calls.every(([args]) => args.includes('--untracked-files=all'))
    ).toBe(true)
  })

  it('uses one normal status for completed clean polls', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    await getStatus('/repo', { includeLineStats: false })
    await getStatus('/repo', { includeLineStats: false })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args.at(-1))).toEqual([
      '--untracked-files=all',
      '--untracked-files=normal'
    ])
  })

  it.each([false, true])(
    'preserves partial rows and branch metadata on a failed read, clean hint=%s',
    async (hasCleanHint) => {
      if (hasCleanHint) {
        gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
        await getStatus('/repo', { includeLineStats: false })
      }
      gitExecFileAsyncMock.mockClear()
      gitStreamOptionsMock.mockImplementationOnce(({ onStdout }) => {
        onStdout('# branch.oid partial\n# branch.head feature\n? top.txt\n')
      })
      gitExecFileAsyncMock.mockRejectedValueOnce(new Error('stream disconnected'))
      const result = await getStatus('/repo', { includeLineStats: false })
      expect(result.entries.map((entry) => entry.path)).toEqual(['top.txt'])
      expect(result.head).toBe('partial')
      expect(result.branch).toBe('refs/heads/feature')
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(gitExecFileAsyncMock.mock.calls[0][0]).toContain(
        `--untracked-files=${hasCleanHint ? 'normal' : 'all'}`
      )
    }
  )

  it('replaces failed normal directory rows with the partial canonical retry', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    await getStatus('/repo', { includeLineStats: false })
    gitExecFileAsyncMock.mockClear()
    gitStreamOptionsMock
      .mockImplementationOnce(({ onStdout }) => onStdout('# branch.oid old\n? new/\n'))
      .mockImplementationOnce(({ onStdout }) => onStdout('# branch.oid current\n? new/a\n'))
    gitExecFileAsyncMock.mockRejectedValue(new Error('stream disconnected'))
    const result = await getStatus('/repo', { includeLineStats: false })
    expect(result.entries.map((entry) => entry.path)).toEqual(['new/a'])
    expect(result.head).toBe('current')
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args.at(-1))).toEqual([
      '--untracked-files=normal',
      '--untracked-files=all'
    ])
  })

  it('retries a new directory once, preserving metadata and host options', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    const options = { includeLineStats: false, wslDistro: 'Ubuntu' }
    await getStatus('/repo', options)
    gitExecFileAsyncMock.mockClear()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('--untracked-files=normal')
        ? '# branch.oid older\n? new/\n'
        : '# branch.oid newer\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +0 -0\n? new/a.ts\n? new/b.ts\n'
    }))
    const result = await getStatus('/repo', options)
    expect(result.entries.map((entry) => entry.path)).toEqual(['new/a.ts', 'new/b.ts'])
    expect(result.head).toBe('newer')
    expect(result.branch).toBe('refs/heads/feature')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    for (const [streamOptions] of gitStreamOptionsMock.mock.calls) {
      expect(streamOptions.cwd).toBe('/repo')
      expect(streamOptions.wslDistro).toBe('Ubuntu')
      expect(streamOptions.preferWslDirectGit).toBe(true)
      expect(streamOptions.env.GIT_OPTIONAL_LOCKS).toBe('0')
    }
    gitExecFileAsyncMock.mockClear()
    await getStatus('/repo', options)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock.mock.calls[0][0]).toContain('--untracked-files=all')
  })

  it('isolates native and separate WSL distro hints for identical cwd strings', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })
    for (const wslDistro of [undefined, 'Ubuntu', 'Debian', undefined]) {
      await getStatus('/repo', { includeLineStats: false, wslDistro })
    }
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args.at(-1))).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=normal'
    ])
  })

  it('keeps ignored reads canonical without allowing the next poll to skip its first full read', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '! new/x.log\n' })
    const result = await getStatus('/repo', { includeIgnored: true, includeLineStats: false })
    expect(result.ignoredPaths).toEqual(['new/x.log'])
    await getStatus('/repo', { includeLineStats: false })
    expect(
      gitExecFileAsyncMock.mock.calls.every(([args]) => args.includes('--untracked-files=all'))
    ).toBe(true)
  })
})
