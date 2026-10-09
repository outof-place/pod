import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildUntrackedDirectoryListingCommands } from '../../../shared/git-status-untracked-directory-expansion'
import { MAX_COMMAND_LINE_CHARS } from '../../../shared/windows-command-line-budget'
import { finishedGitCommandLineLength } from './git-pathspec'
import {
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from '../wsl-git-read-environment'

describe('untracked-directory listing launch budget', () => {
  const platform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    resetWslGitReadEnvironmentForTests()
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it.each([6_609, 26_409])(
    'budgets direct and fallback WSL routes with a %s-character PATH',
    (pathLength) => {
      const distro = 'Ubuntu-24.04'
      seedWslGitReadEnvironmentForTests(distro, {
        path: `/usr/bin:${'x'.repeat(pathLength - 9)}`,
        home: '/home/user',
        gitPath: '/usr/bin/git'
      })
      const directories = Array.from(
        { length: 200 },
        (_, index) => `dir-${index}-${'x'.repeat(90)}/`
      )
      const cwd = `\\\\wsl$\\${distro}\\home\\user\\project`
      const measure = (args: readonly string[]) =>
        finishedGitCommandLineLength(
          args,
          cwd,
          { wslDistro: distro },
          {
            preferWslDirectGit: true,
            env: { GIT_OPTIONAL_LOCKS: '0' }
          }
        )
      const commands = buildUntrackedDirectoryListingCommands(directories, measure)

      expect(commands.flatMap((args) => args.slice(6))).toEqual(
        directories.map((directory) => `:(top,literal)${directory}`)
      )
      for (const args of commands) {
        expect(measure(args)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
      }
    }
  )

  it.each([undefined, 'Ubuntu-24.04'])(
    'budgets the resolved command for distro %s',
    (wslDistro) => {
      const directories = Array.from(
        { length: 200 },
        (_, index) => `new folder-${index}-${'x'.repeat(180)}/`
      )
      const cwd = wslDistro ? `\\\\wsl$\\${wslDistro}\\home\\user\\project` : 'C:\\project'
      const measure = (args: readonly string[]) =>
        finishedGitCommandLineLength(args, cwd, { wslDistro })

      const commands = buildUntrackedDirectoryListingCommands(directories, measure)

      expect(commands.length).toBeGreaterThan(1)
      expect(commands.flatMap((args) => args.slice(6))).toEqual(
        directories.map((directory) => `:(top,literal)${directory}`)
      )
      for (const args of commands) {
        expect(measure(args)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
      }
    }
  )
})
