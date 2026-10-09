import { describe, expect, it, vi } from 'vitest'
import { GitStatusUntrackedMode, type GitStatusStdoutStream } from './git-status-untracked-mode'

const statusArgs = [
  '-c',
  'core.quotePath=false',
  'status',
  '--porcelain=v2',
  '--branch',
  '--untracked-files=all'
]

function harness(mode = new GitStatusUntrackedMode()) {
  let output = ''
  const streamGit = vi.fn<GitStatusStdoutStream>(async (_args, onStdout) => ({
    stoppedEarly: onStdout(output)
  }))
  const read = (
    key = '/repo',
    options: { limit?: number; includeIgnored?: boolean; signal?: AbortSignal } = {}
  ) => mode.read({ key, statusArgs, limit: options.limit ?? 0, streamGit, ...options })
  return {
    mode,
    streamGit,
    read,
    output: (text: string) => {
      output = text
    }
  }
}

function modes(stream: ReturnType<typeof harness>['streamGit']): string[] {
  return stream.mock.calls.flatMap(([args]) =>
    args.filter((arg) => arg.startsWith('--untracked-files='))
  )
}

describe('execution-host untracked status mode', () => {
  it('uses one full status initially and one normal status for clean or top-level files', async () => {
    const h = harness()
    await h.read()
    h.output('? top.txt\n')
    expect((await h.read()).parser.entries.map((entry) => entry.path)).toEqual(['top.txt'])
    h.output('? other.txt\n')
    expect((await h.read()).parser.entries.map((entry) => entry.path)).toEqual(['other.txt'])
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=normal',
      '--untracked-files=normal'
    ])
  })

  it('uses one full status throughout directory-heavy workloads', async () => {
    const h = harness()
    h.output('? new/a\n? new/b\n')
    await h.read()
    await h.read()
    expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=all'])
  })

  it.each(['new/', './', '../sibling/', 'nested-repo/'])(
    'retries canonical status once when %s first appears',
    async (directory) => {
      const h = harness()
      await h.read()
      h.streamGit.mockClear()
      h.streamGit.mockImplementation(async (args, onStdout) => ({
        stoppedEarly: onStdout(
          args.includes('--untracked-files=normal')
            ? `# branch.oid before\n? ${directory}\n? z\n`
            : '# branch.oid after\n? new/a\n? new/b\n? z\n'
        )
      }))
      const status = await h.read()
      expect(status.parser.entries.map((entry) => entry.path)).toEqual(['new/a', 'new/b', 'z'])
      expect(status.parser.branch.head).toBe('after')
      await h.read()
      expect(modes(h.streamGit)).toEqual([
        '--untracked-files=normal',
        '--untracked-files=all',
        '--untracked-files=all'
      ])
      for (const [args] of h.streamGit.mock.calls) {
        expect(args.slice(0, -1)).toEqual(statusArgs.slice(0, -1))
      }
    }
  )

  it('preserves the canonical capped prefix and then uses one full status', async () => {
    const h = harness()
    await h.read()
    h.streamGit.mockClear()
    h.streamGit.mockImplementation(async (args, onStdout) => ({
      stoppedEarly: onStdout(
        args.includes('--untracked-files=normal')
          ? '? aaa/\n? b\n? c\n'
          : '? aaa/a\n? aaa/b\n? aaa/c\n? b\n'
      )
    }))
    const status = await h.read('/repo', { limit: 2 })
    expect(status.parser.entries.map((entry) => entry.path)).toEqual(['aaa/a', 'aaa/b', 'aaa/c'])
    expect(status.stoppedEarly).toBe(true)
    expect(status.parser.statusLength).toBe(3)
    await h.read('/repo', { limit: 2 })
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=normal',
      '--untracked-files=all',
      '--untracked-files=all'
    ])
  })

  it('never learns normal mode from a capped full read', async () => {
    const h = harness()
    h.output('? a\n? b\n? c\n? hidden/d\n')
    await h.read('/repo', { limit: 2 })
    await h.read('/repo', { limit: 2 })
    expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=all'])
  })

  it('keeps ignored reads in full mode without establishing eligibility', async () => {
    const h = harness()
    h.output('! ignored/\n')
    expect((await h.read('/repo', { includeIgnored: true })).parser.ignoredPaths).toEqual([
      'ignored/'
    ])
    await h.read()
    expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=all'])
  })

  it('learns normal mode again only after directories disappear', async () => {
    const h = harness()
    h.output('? dir/a\n')
    await h.read()
    h.output('')
    await h.read()
    await h.read()
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=normal'
    ])
  })

  it('keeps native, WSL distro and relay owner hints isolated', async () => {
    const h = harness()
    await h.read('native\0/repo')
    await h.read('wsl-a\0/repo')
    await h.read('wsl-b\0/repo')
    await h.read('native\0/repo')
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=normal'
    ])
    const otherRelay = harness()
    await otherRelay.read('native\0/repo')
    expect(modes(otherRelay.streamGit)).toEqual(['--untracked-files=all'])
  })

  it('evicts least recently used hints within a fixed bound', async () => {
    const h = harness(new GitStatusUntrackedMode(2))
    for (const key of ['a', 'b', 'a', 'c', 'a', 'b']) {
      await h.read(key)
    }
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=normal',
      '--untracked-files=all',
      '--untracked-files=normal',
      '--untracked-files=all'
    ])
  })

  it.each([false, true])(
    'does not establish eligibility after a cancelled read, ignored=%s',
    async (includeIgnored) => {
      const h = harness()
      const controller = new AbortController()
      h.streamGit.mockImplementationOnce(async (_args, onStdout) => {
        onStdout('')
        controller.abort()
        return { stoppedEarly: false }
      })
      await expect(
        h.read('/repo', { signal: controller.signal, includeIgnored })
      ).rejects.toMatchObject({ name: 'AbortError' })
      await h.read()
      expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=all'])
    }
  )

  it('does not start fallback after cancellation', async () => {
    const h = harness()
    await h.read()
    const controller = new AbortController()
    h.streamGit.mockImplementationOnce(async (_args, onStdout) => {
      onStdout('? new/\n')
      controller.abort()
      return { stoppedEarly: false }
    })
    await expect(h.read('/repo', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=normal'])
  })

  it('does not establish eligibility from failed reads or publish collapsed rows after a failed retry', async () => {
    const h = harness()
    const failure = new Error('disconnected')
    h.streamGit.mockRejectedValueOnce(failure)
    await expect(h.read()).rejects.toBe(failure)
    await h.read()
    h.streamGit.mockImplementationOnce(async (_args, onStdout) => ({
      stoppedEarly: onStdout('? new/\n')
    }))
    h.streamGit.mockRejectedValueOnce(failure)
    await expect(h.read()).rejects.toBe(failure)
    await h.read()
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=normal',
      '--untracked-files=all',
      '--untracked-files=all'
    ])
  })

  it('recovers a failed normal scan that emitted a collapsed directory', async () => {
    const h = harness()
    await h.read()
    h.streamGit.mockImplementationOnce(async (_args, onStdout) => {
      onStdout('# branch.oid old\n? new/\n')
      throw new Error('interrupted')
    })
    h.output('# branch.oid current\n? new/a\n')
    const status = await h.read()
    expect(status.parser.entries.map((entry) => entry.path)).toEqual(['new/a'])
    expect(status.parser.branch.head).toBe('current')
    await h.read()
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=normal',
      '--untracked-files=all',
      '--untracked-files=all'
    ])
  })

  it('does not repopulate a cleared hint with an older read', async () => {
    const h = harness()
    let release = () => {}
    h.streamGit.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { stoppedEarly: false }
    })
    const older = h.read()
    h.mode.clear()
    release()
    await older
    await h.read()
    expect(modes(h.streamGit)).toEqual(['--untracked-files=all', '--untracked-files=all'])
  })

  it('does not overwrite a newer directory observation with an older clean completion', async () => {
    const h = harness()
    let release = () => {}
    h.streamGit.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { stoppedEarly: false }
    })
    const older = h.read()
    h.output('? new/a\n')
    await h.read()
    release()
    await older
    await h.read()
    expect(modes(h.streamGit)).toEqual([
      '--untracked-files=all',
      '--untracked-files=all',
      '--untracked-files=all'
    ])
  })
})
