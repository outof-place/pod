import { describe, expect, it, vi } from 'vitest'
import { GitStatusUntrackedMode } from '../shared/git-status-untracked-mode'
import { getStatusOp } from './git-handler-status-ops'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'

const params = { worktreePath: '/remote/repo', includeLineStats: false }
const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

function harness() {
  let output = ''
  const stream = vi.fn<RelayGitStreamExec>(async (_args, _cwd, options) => ({
    stoppedEarly: options.onStdout(output) === true
  }))
  const untrackedMode = new GitStatusUntrackedMode()
  const read = (signal?: AbortSignal) => getStatusOp(git, stream, params, { signal, untrackedMode })
  return {
    stream,
    read,
    output: (text: string) => {
      output = text
    }
  }
}

describe('relay adaptive status host contract', () => {
  it('uses one normal status for a previously completed clean read', async () => {
    const h = harness()
    await h.read()
    await h.read()
    expect(h.stream.mock.calls.map(([args]) => args.at(-1))).toEqual([
      '--untracked-files=all',
      '--untracked-files=normal'
    ])
    const otherOwner = harness()
    await otherOwner.read()
    expect(otherOwner.stream.mock.calls[0][0]).toContain('--untracked-files=all')
  })

  it('preserves global options, host, optional locks, cancellation and retried metadata', async () => {
    const h = harness()
    const controller = new AbortController()
    await h.read(controller.signal)
    h.stream.mockClear()
    h.stream.mockImplementation(async (args, _cwd, options) => ({
      stoppedEarly:
        options.onStdout(
          args.includes('--untracked-files=normal')
            ? '# branch.oid old\n? new/\n'
            : '# branch.oid new\n? new/a\n? new/b\n'
        ) === true
    }))
    const status = await h.read(controller.signal)
    expect(status.entries.map((entry) => entry.path)).toEqual(['new/a', 'new/b'])
    expect(status.head).toBe('new')
    expect(h.stream).toHaveBeenCalledTimes(2)
    for (const [args, cwd, options] of h.stream.mock.calls) {
      expect(args.slice(0, 4)).toEqual([
        '-c',
        'core.quotePath=false',
        '-c',
        'diff.autoRefreshIndex=false'
      ])
      expect(cwd).toBe('/remote/repo')
      expect(options.disableOptionalLocks).toBe(true)
      expect(options.signal).toBe(controller.signal)
    }
    h.stream.mockClear()
    await h.read(controller.signal)
    expect(h.stream).toHaveBeenCalledTimes(1)
    expect(h.stream.mock.calls[0][0]).toContain('--untracked-files=all')
  })

  it('does not publish collapsed rows when canonical recovery fails', async () => {
    const h = harness()
    await h.read()
    h.stream.mockImplementationOnce(async (_args, _cwd, options) => ({
      stoppedEarly: options.onStdout('? new/\n') === true
    }))
    h.stream.mockRejectedValueOnce(new Error('disconnected'))
    const status = await h.read()
    expect(status.entries).toEqual([])
    expect(status.head).toBeUndefined()
    expect(status.upstreamStatus).toBeUndefined()
  })

  it.each([false, true])(
    'keeps rejected partial status empty, clean hint=%s',
    async (hasCleanHint) => {
      const h = harness()
      if (hasCleanHint) {
        await h.read()
      }
      h.stream.mockImplementationOnce(async (_args, _cwd, options) => {
        options.onStdout('# branch.oid partial\n? top.txt\n')
        throw new Error('disconnected')
      })
      const status = await h.read()
      expect(status.entries).toEqual([])
      expect(status.head).toBeUndefined()
    }
  )
})
