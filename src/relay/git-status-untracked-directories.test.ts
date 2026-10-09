import { describe, expect, it, vi } from 'vitest'
import { StatusPorcelainParser } from '../shared/git-status-porcelain-parser'
import { expandRelayStatusUntrackedDirectories } from './git-status-untracked-directories'
import type { RelayGitStreamExec } from './git-stdout-stream'

const statusArgs = [
  '-c',
  'core.quotePath=false',
  'status',
  '--porcelain=v2',
  '--untracked-files=normal'
]

function collapsedStatus(): StatusPorcelainParser {
  const parser = new StatusPorcelainParser()
  parser.update('# branch.oid old\n? new/\n', 0)
  parser.finish()
  return parser
}

describe('relay untracked listing recovery', () => {
  it('streams a capped all-mode retry on the same host and uses the new metadata', async () => {
    const controller = new AbortController()
    const streamGit = vi.fn<RelayGitStreamExec>(async (args, _cwd, options) => {
      if (args[0] === 'rev-parse') {
        return { stoppedEarly: options.onStdout('\n') === true }
      }
      if (args[0] === 'ls-files') {
        options.onStdout('new/partial.txt\0')
        throw new Error('read failed')
      }
      return {
        stoppedEarly: options.onStdout('# branch.oid new\n? new/a\n? new/b\n? new/c\n') === true
      }
    })

    const expanded = await expandRelayStatusUntrackedDirectories(
      streamGit,
      { parser: collapsedStatus(), stoppedEarly: false },
      { worktreePath: '/remote/project', limit: 2, signal: controller.signal },
      statusArgs
    )

    expect(expanded.records.map((record) => record.type === 'entry' && record.entry.path)).toEqual([
      'new/a',
      'new/b',
      'new/c'
    ])
    expect(expanded.parser.branch.head).toBe('new')
    expect(expanded.stoppedEarly).toBe(true)
    expect(expanded.statusLength).toBe(3)
    expect(streamGit.mock.calls[2][0]).toEqual([
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--untracked-files=all'
    ])
    for (const [, cwd, options] of streamGit.mock.calls) {
      expect(cwd).toBe('/remote/project')
      expect(options.signal).toBe(controller.signal)
      expect(options.disableOptionalLocks).toBe(true)
    }
  })

  it('does not retry after cancellation', async () => {
    const controller = new AbortController()
    const failure = new Error('cancelled')
    const streamGit = vi.fn<RelayGitStreamExec>(async () => {
      controller.abort()
      throw failure
    })

    await expect(
      expandRelayStatusUntrackedDirectories(
        streamGit,
        { parser: collapsedStatus(), stoppedEarly: false },
        { worktreePath: '/remote/project', limit: 2, signal: controller.signal },
        statusArgs
      )
    ).rejects.toBe(failure)
    expect(streamGit).toHaveBeenCalledTimes(1)
  })

  it('retries with status when shell startup output corrupts the first NUL path', async () => {
    const streamGit = vi.fn<RelayGitStreamExec>(async (args, _cwd, options) => ({
      stoppedEarly:
        options.onStdout(
          args[0] === 'rev-parse'
            ? '\n'
            : args[0] === 'ls-files'
              ? 'Welcome to Linux\nnew/a\0new/b\0'
              : 'Welcome to Linux\n? new/a\n? new/b\n'
        ) === true
    }))

    const expanded = await expandRelayStatusUntrackedDirectories(
      streamGit,
      { parser: collapsedStatus(), stoppedEarly: false },
      { worktreePath: '/remote/project', limit: 0 },
      statusArgs
    )

    expect(expanded.records.map((record) => record.type === 'entry' && record.entry.path)).toEqual([
      'new/a',
      'new/b'
    ])
    expect(streamGit.mock.calls[2][0]).toContain('--untracked-files=all')
  })

  it('rejects when both the listing and the complete retry fail', async () => {
    const failure = new Error('host unavailable')
    const streamGit = vi.fn<RelayGitStreamExec>(async () => {
      throw failure
    })

    await expect(
      expandRelayStatusUntrackedDirectories(
        streamGit,
        { parser: collapsedStatus(), stoppedEarly: false },
        { worktreePath: '/remote/project', limit: 0 },
        statusArgs
      )
    ).rejects.toBe(failure)
    expect(streamGit).toHaveBeenCalledTimes(2)
  })
})
