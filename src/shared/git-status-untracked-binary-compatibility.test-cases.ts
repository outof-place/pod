import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import {
  expandUntrackedDirectoryRecords,
  statusUntrackedFilesArg
} from './git-status-untracked-directory-expansion'

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

export function registerUntrackedDirectoryExpansionBinaryCompatibilityCases(
  runGit: RunGit,
  resolveFixture: (name: string) => { hostPath: string; gitCwd: string }
): void {
  it('lists the same untracked rows from normal mode plus ls-files as from untracked=all', async () => {
    const { hostPath, gitCwd } = resolveFixture('untracked-expansion')
    const runFixtureGit: RunGit = (args) => runGit(['-C', gitCwd, ...args])
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
    await runFixtureGit(['init', '-q'])
    await writeFile(join(hostPath, '.gitignore'), '*.log\n')
    for (const nested of ['nested', 'new/sub']) {
      await mkdir(join(hostPath, nested), { recursive: true })
      await runGit(['-C', `${gitCwd}/${nested}`, 'init', '-q'])
      await writeFile(join(hostPath, nested, 'inner.txt'), 'nested\n')
    }

    const allRecords = await readStatusRecords(runFixtureGit, statusUntrackedFilesArg(true))
    const expansion = await expandUntrackedDirectoryRecords({
      records: await readStatusRecords(runFixtureGit, statusUntrackedFilesArg(false)),
      limit: 0,
      listUntracked: async (args, onStdout) => ({
        stoppedEarly: onStdout((await runFixtureGit(args)).stdout)
      })
    })

    expect(expansion?.records).toEqual(allRecords)
    expect(allRecords.map((record) => record.type === 'entry' && record.entry.path)).toEqual(
      expect.arrayContaining(['[k]eep/glob.txt', 'keep/sibling.txt', 'nested/', 'new/sub/'])
    )
  })
}
