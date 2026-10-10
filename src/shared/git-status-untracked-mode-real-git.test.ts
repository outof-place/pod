import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import { GitStatusUntrackedMode, type GitStatusStdoutStream } from './git-status-untracked-mode'

const tempRoots: string[] = []

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-untracked-mode-'))
  tempRoots.push(root)
  const repo = join(root, 'repo')
  const config = join(root, 'empty-gitconfig')
  await mkdir(repo)
  await writeFile(config, '')
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    GIT_OPTIONAL_LOCKS: '0'
  }
  async function git(args: string[], cwd = repo): Promise<string> {
    const result = await runProcess({
      program: 'git',
      args: ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
      cwd,
      env
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(`Fixture Git failed: ${result.stderr}`)
    }
    return result.stdout
  }
  async function write(relativePath: string, contents = 'untracked\n'): Promise<void> {
    const target = join(repo, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  await git(['init', '-q'])
  return { repo, git, write }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function readStatus(fixture: Fixture, mode: 'normal' | 'all', limit = 0) {
  const stdout = await fixture.git([
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    `--untracked-files=${mode}`
  ])
  const parser = new StatusPorcelainParser()
  const stoppedEarly = parser.update(stdout, limit)
  if (!stoppedEarly) {
    parser.finish()
  }
  return { parser, stoppedEarly }
}

const statusArgs = [
  '-c',
  'core.quotePath=false',
  'status',
  '--porcelain=v2',
  '--untracked-files=all'
]

async function readAdaptiveStatus(
  fixture: Fixture,
  limit = 0,
  mode = new GitStatusUntrackedMode(),
  streamGit?: GitStatusStdoutStream
) {
  return mode.read({
    key: fixture.repo,
    statusArgs,
    limit,
    streamGit:
      streamGit ?? (async (args, onStdout) => ({ stoppedEarly: onStdout(await fixture.git(args)) }))
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('adaptive untracked status against real Git', () => {
  it.each([true, false])(
    'preserves nested workspace status with status.relativePaths=%s',
    async (relativePaths) => {
      const fixture = await createFixture()
      await fixture.git(['config', 'status.relativePaths', String(relativePaths)])
      await mkdir(join(fixture.repo, 'workspace'))
      const cwd = join(fixture.repo, 'workspace')
      const folderFixture = { ...fixture, git: (args: string[]) => fixture.git(args, cwd) }
      const mode = new GitStatusUntrackedMode()
      const calls: string[][] = []
      const streamGit: GitStatusStdoutStream = async (args, onStdout) => {
        calls.push(args)
        return { stoppedEarly: onStdout(await folderFixture.git(args)) }
      }
      await readAdaptiveStatus(folderFixture, 0, mode, streamGit)
      await fixture.write('workspace/inside/new.txt', 'first\nsecond\n')
      await fixture.write('sibling/new.txt')
      const baseline = await readStatus(folderFixture, 'all')
      calls.length = 0
      const expanded = await readAdaptiveStatus(folderFixture, 0, mode, streamGit)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('--untracked-files=normal')
      expect(calls[1]).toContain('--untracked-files=all')
      calls.length = 0
      await readAdaptiveStatus(folderFixture, 0, mode, streamGit)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('--untracked-files=all')

      expect(expanded.parser.statusRecords).toEqual(baseline.parser.statusRecords)
      expect(
        expanded.parser.statusRecords.map((record) => record.type === 'entry' && record.entry.path)
      ).toEqual(
        relativePaths
          ? ['../sibling/new.txt', 'inside/new.txt']
          : ['sibling/new.txt', 'workspace/inside/new.txt']
      )
    }
  )

  it.each([2, 3, 4])('keeps the ordered file prefix at limit %i', async (limit) => {
    const fixture = await createFixture()
    const mode = new GitStatusUntrackedMode()
    await readAdaptiveStatus(fixture, 0, mode)
    for (const file of ['aaa/a', 'aaa/b', 'aaa/c', 'b', 'c', 'd', 'e']) {
      await fixture.write(file)
    }
    const baseline = await readStatus(fixture, 'all', limit)
    const expanded = await readAdaptiveStatus(fixture, limit, mode)

    expect(expanded.stoppedEarly).toBe(true)
    expect(expanded.parser.statusRecords.slice(0, limit)).toEqual(
      baseline.parser.statusRecords.slice(0, limit)
    )
    expect(expanded.parser.statusLength).toBe(limit + 1)
  })

  it('preserves tracked rows before canonical fallback at the cap', async () => {
    const fixture = await createFixture()
    const mode = new GitStatusUntrackedMode()
    await readAdaptiveStatus(fixture, 0, mode)
    await fixture.write('tracked.txt', 'before\n')
    await fixture.git(['add', 'tracked.txt'])
    await fixture.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
    await fixture.write('tracked.txt', 'after\n')
    for (const file of ['aaa/a', 'aaa/b', 'aaa/c', 'aaa2/a', 'b', 'c']) {
      await fixture.write(file)
    }
    const baseline = await readStatus(fixture, 'all', 3)
    const expanded = await readAdaptiveStatus(fixture, 3, mode)

    expect(expanded.parser.statusRecords.slice(0, 3)).toEqual(
      baseline.parser.statusRecords.slice(0, 3)
    )
    expect(expanded.parser.statusLength).toBe(4)
    expect(expanded.stoppedEarly).toBe(true)
  })

  it('matches initialized, empty, and nested repositories without listing their private files', async () => {
    const fixture = await createFixture()
    const mode = new GitStatusUntrackedMode()
    await readAdaptiveStatus(fixture, 0, mode)
    for (const nested of ['empty', 'uncommitted', 'committed', 'outer/nested']) {
      const target = join(fixture.repo, nested)
      await mkdir(target, { recursive: true })
      await fixture.git(['init', '-q'], target)
    }
    for (const nested of ['uncommitted', 'committed', 'outer/nested']) {
      await fixture.write(`${nested}/inside.txt`)
    }
    const committed = join(fixture.repo, 'committed')
    await fixture.git(['add', 'inside.txt'], committed)
    await fixture.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested'], committed)
    await mkdir(join(fixture.repo, 'plain-empty'))
    await mkdir(join(fixture.repo, 'fake/.git'), { recursive: true })
    await fixture.write('fake/visible.txt')
    const baseline = await readStatus(fixture, 'all')
    const expanded = await readAdaptiveStatus(fixture, 0, mode)

    expect(expanded.parser.statusRecords).toEqual(baseline.parser.statusRecords)
    expect(
      expanded.parser.statusRecords.map((record) => record.type === 'entry' && record.entry.path)
    ).toEqual(['committed/', 'empty/', 'fake/visible.txt', 'outer/nested/', 'uncommitted/'])
  })

  it('honors nested ignore rules and literal directory prefixes', async () => {
    const fixture = await createFixture()
    const mode = new GitStatusUntrackedMode()
    await readAdaptiveStatus(fixture, 0, mode)
    await fixture.write('.gitignore', '*.log\nignored/*\n!ignored/keep.txt\n')
    await fixture.write('nested/.gitignore', 'drop.txt\n')
    await fixture.write('fully-ignored/.gitignore', '*\n')
    for (const file of [
      'ignored/keep.txt',
      'ignored/drop.txt',
      'ignored/drop.log',
      'nested/keep.txt',
      'nested/drop.txt',
      'fully-ignored/drop.txt',
      '[k]eep/file.txt',
      'keep/file.txt',
      'keep2/file.txt',
      'sp ace/file.txt',
      'ünï/日本語.txt'
    ]) {
      await fixture.write(file)
    }
    const baseline = await readStatus(fixture, 'all')
    const expanded = await readAdaptiveStatus(fixture, 0, mode)

    expect(expanded.parser.statusRecords).toEqual(baseline.parser.statusRecords)
    const paths = expanded.parser.statusRecords.flatMap((record) =>
      record.type === 'entry' ? [record.entry.path] : []
    )
    expect(paths).toEqual(
      expect.arrayContaining(['[k]eep/file.txt', 'keep/file.txt', 'keep2/file.txt'])
    )
    expect(paths).not.toContain('nested/drop.txt')
    expect(paths).not.toContain('ignored/drop.txt')
    expect(paths).not.toContain('fully-ignored/drop.txt')
  })

  it.skipIf(process.platform === 'win32')(
    'preserves symlinks and filenames requiring Git quoting',
    async () => {
      const fixture = await createFixture()
      const mode = new GitStatusUntrackedMode()
      await readAdaptiveStatus(fixture, 0, mode)
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
        await fixture.write(file)
      }
      await symlink('target', join(fixture.repo, 'link'))
      await symlink('missing', join(fixture.repo, 'dangling'))
      await symlink('../target', join(fixture.repo, 'outer/link'))
      const baseline = await readStatus(fixture, 'all')
      const expanded = await readAdaptiveStatus(fixture, 0, mode)

      expect(expanded.parser.statusRecords).toEqual(baseline.parser.statusRecords)
      const paths = expanded.parser.statusRecords.flatMap((record) =>
        record.type === 'entry' ? [record.entry.path] : []
      )
      expect(paths).toEqual(
        expect.arrayContaining(['link', 'dangling', 'outer/link', 'line\nbreak/tab\tfile'])
      )
      expect(paths).not.toContain('link/visible.txt')
      expect(paths).not.toContain('outer/link/visible.txt')
    }
  )
})
