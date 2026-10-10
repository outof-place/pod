import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import { GitStatusUntrackedMode } from './git-status-untracked-mode'

type RunGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>

async function readStatusRecords(
  runFixtureGit: RunGit,
  untrackedArg: string
): Promise<StatusPorcelainParser['statusRecords']> {
  const { stdout } = await runFixtureGit([
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    untrackedArg
  ])
  const parser = new StatusPorcelainParser()
  parser.update(stdout, 0)
  parser.finish()
  return parser.statusRecords
}

export function registerAdaptiveGitStatusBinaryCompatibilityCases(
  runGit: RunGit,
  resolveFixture: (name: string) => { hostPath: string; gitCwd: string }
): void {
  it('keeps adaptive status canonical on the Git baseline', async () => {
    const { hostPath, gitCwd } = resolveFixture('adaptive-untracked')
    const runFixtureGit: RunGit = (args) => runGit(['-C', gitCwd, ...args])
    const statusArgs = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--untracked-files=all'
    ]
    const mode = new GitStatusUntrackedMode()
    const calls: string[][] = []
    const read = (run: RunGit, key: string) =>
      mode.read({
        key,
        statusArgs,
        limit: 0,
        streamGit: async (args, onStdout) => {
          calls.push(args)
          return { stoppedEarly: onStdout((await run(args)).stdout) }
        }
      })
    await mkdir(hostPath, { recursive: true })
    await runFixtureGit(['init', '-q'])
    await read(runFixtureGit, gitCwd)
    const files = [
      'new/a.ts',
      'new/deep/deeper/c.ts',
      'new/ignored.log',
      'only-ignored/x.log',
      'sp ace/q"uote/f.txt',
      '[k]eep/glob.txt',
      'keep/sibling.txt',
      'ünï/é.txt',
      'top.txt'
    ]
    await mkdir(join(hostPath, 'empty-dir'), { recursive: true })
    for (const file of files) {
      await mkdir(join(hostPath, file, '..'), { recursive: true })
      await writeFile(join(hostPath, file), 'untracked\n')
    }
    await writeFile(join(hostPath, '.gitignore'), '*.log\n')
    for (const nested of ['nested', 'new/sub']) {
      await mkdir(join(hostPath, nested), { recursive: true })
      await runGit(['-C', `${gitCwd}/${nested}`, 'init', '-q'])
      await writeFile(join(hostPath, nested, 'inner.txt'), 'nested\n')
    }

    const allRecords = await readStatusRecords(runFixtureGit, '--untracked-files=all')
    calls.length = 0
    const status = await read(runFixtureGit, gitCwd)
    expect(calls.map((args) => args.at(-1))).toEqual([
      '--untracked-files=normal',
      '--untracked-files=all'
    ])
    expect(status.parser.statusRecords).toEqual(allRecords)
    const nestedRun: RunGit = (args) => runGit(['-C', `${gitCwd}/sp ace`, ...args])
    expect((await read(nestedRun, `${gitCwd}/sp ace`)).parser.statusRecords).toEqual(
      await readStatusRecords(nestedRun, '--untracked-files=all')
    )

    expect(allRecords.map((record) => record.type === 'entry' && record.entry.path)).toEqual(
      expect.arrayContaining(['[k]eep/glob.txt', 'keep/sibling.txt', 'nested/', 'new/sub/'])
    )
  })
}
