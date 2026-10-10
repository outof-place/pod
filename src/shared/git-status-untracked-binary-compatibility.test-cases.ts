import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { expect, it } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import { GitStatusUntrackedMode } from './git-status-untracked-mode'

type RunGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>
const statusArgs = [
  '-c',
  'core.quotePath=false',
  'status',
  '--porcelain=v2',
  '--untracked-files=all'
]

export function registerAdaptiveGitStatusBinaryCompatibilityCases(
  runGit: RunGit,
  resolveFixture: (name: string) => { hostPath: string; gitCwd: string }
): void {
  async function fixture(name: string) {
    const { hostPath, gitCwd } = resolveFixture(`adaptive-${name}`)
    await mkdir(hostPath, { recursive: true })
    const gitPath = (...parts: string[]) =>
      (hostPath === gitCwd ? join : posix.join)(gitCwd, ...parts)
    const git = (args: string[], cwd = gitCwd) =>
      runGit(['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args])
    const write = async (file: string, contents = 'untracked\n') => {
      await mkdir(dirname(join(hostPath, file)), { recursive: true })
      await writeFile(join(hostPath, file), contents)
    }
    await git(['init', '-q'])
    const mode = new GitStatusUntrackedMode()
    const calls: string[][] = []
    const read = (limit = 0, cwd = gitCwd) =>
      mode.read({
        key: cwd,
        statusArgs,
        limit,
        streamGit: async (args, onStdout) => {
          calls.push(args)
          return { stoppedEarly: onStdout((await git(args, cwd)).stdout) }
        }
      })
    const canonical = async (limit = 0, cwd = gitCwd) => {
      const parser = new StatusPorcelainParser()
      const stoppedEarly = parser.update((await git(statusArgs, cwd)).stdout, limit)
      if (!stoppedEarly) {
        parser.finish()
      }
      return { parser, stoppedEarly }
    }
    return { hostPath, git, gitPath, write, read, canonical, calls }
  }

  it('keeps literal paths, nested repositories, ignores and symlinks canonical', async () => {
    const f = await fixture('paths')
    await f.read()
    await f.write('.gitignore', '*.log\nignored/*\n!ignored/keep.txt\n')
    await f.write('nested/.gitignore', 'drop.txt\n')
    await f.write('fully-ignored/.gitignore', '*\n')
    for (const file of [
      'new/a.ts',
      'new/deep/deeper/c.ts',
      'new/ignored.log',
      'only-ignored/x.log',
      'ignored/keep.txt',
      'ignored/drop.txt',
      'nested/keep.txt',
      'nested/drop.txt',
      'fully-ignored/drop.txt',
      'sp ace/q"uote/f.txt',
      '[k]eep/glob.txt',
      'keep/sibling.txt',
      'keep2/file.txt',
      'ünï/日本語.txt',
      'top.txt',
      'fake/visible.txt'
    ]) {
      await f.write(file)
    }
    for (const nested of ['empty', 'uncommitted', 'committed', 'outer/nested']) {
      await mkdir(join(f.hostPath, nested), { recursive: true })
      await f.git(['init', '-q'], f.gitPath(nested))
      if (nested !== 'empty') {
        await f.write(`${nested}/inside.txt`)
      }
    }
    await f.git(['add', 'inside.txt'], f.gitPath('committed'))
    await f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested'], f.gitPath('committed'))
    await mkdir(join(f.hostPath, 'plain-empty'))
    await mkdir(join(f.hostPath, 'fake/.git'), { recursive: true })
    if (process.platform !== 'win32') {
      for (const file of [
        'target/visible.txt',
        'outer/plain.txt',
        'a*/file.txt',
        'ab/file.txt',
        'a?/file.txt',
        'ac/file.txt',
        'line\nbreak/tab\tfile',
        'q"uote/back\\slash',
        ':(top,literal)magic/file.txt'
      ]) {
        await f.write(file)
      }
      await symlink('target', join(f.hostPath, 'link'))
      await symlink('missing', join(f.hostPath, 'dangling'))
      await symlink('../target', join(f.hostPath, 'outer/link'))
    }
    const baseline = await f.canonical()
    f.calls.length = 0
    const status = await f.read()
    expect(f.calls.map((args) => args.at(-1))).toEqual([
      '--untracked-files=normal',
      '--untracked-files=all'
    ])
    expect(status.parser.statusRecords).toEqual(baseline.parser.statusRecords)
    const paths = status.parser.entries.map((entry) => entry.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        '[k]eep/glob.txt',
        'keep/sibling.txt',
        'keep2/file.txt',
        'ignored/keep.txt',
        'committed/',
        'empty/',
        'outer/nested/',
        'uncommitted/',
        'fake/visible.txt'
      ])
    )
    expect(paths).not.toContain('nested/drop.txt')
    expect(paths).not.toContain('ignored/drop.txt')
    expect(paths).not.toContain('fully-ignored/drop.txt')
    if (process.platform !== 'win32') {
      expect(paths).toEqual(
        expect.arrayContaining(['link', 'dangling', 'outer/link', 'line\nbreak/tab\tfile'])
      )
      expect(paths).not.toContain('link/visible.txt')
      expect(paths).not.toContain('outer/link/visible.txt')
    }
    f.calls.length = 0
    await f.read()
    expect(f.calls.map((args) => args.at(-1))).toEqual(['--untracked-files=all'])
  })

  it.each([true, false])(
    'preserves nested cwd with status.relativePaths=%s',
    async (relativePaths) => {
      const f = await fixture(`relative-${relativePaths}`)
      await f.git(['config', 'status.relativePaths', String(relativePaths)])
      await mkdir(join(f.hostPath, 'workspace'))
      const cwd = f.gitPath('workspace')
      await f.read(0, cwd)
      await f.write('workspace/inside/new.txt')
      await f.write('sibling/new.txt')
      const status = await f.read(0, cwd)
      expect(status.parser.statusRecords).toEqual((await f.canonical(0, cwd)).parser.statusRecords)
      expect(status.parser.entries.map((entry) => entry.path)).toEqual(
        relativePaths
          ? ['../sibling/new.txt', 'inside/new.txt']
          : ['sibling/new.txt', 'workspace/inside/new.txt']
      )
    }
  )

  it.each([2, 3, 4])('preserves tracked and untracked prefixes at limit %i', async (limit) => {
    const f = await fixture(`cap-${limit}`)
    await f.write('tracked.txt', 'before\n')
    await f.git(['add', 'tracked.txt'])
    await f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
    await f.read()
    await f.write('tracked.txt', 'after\n')
    for (const file of ['aaa/a', 'aaa/b', 'aaa/c', 'aaa2/a', 'b', 'c', 'd', 'e']) {
      await f.write(file)
    }
    const status = await f.read(limit)
    const baseline = await f.canonical(limit)
    expect(status.parser.statusRecords.slice(0, limit)).toEqual(
      baseline.parser.statusRecords.slice(0, limit)
    )
    expect(status.parser.statusLength).toBe(limit + 1)
    expect(status.stoppedEarly).toBe(true)
  })
}
