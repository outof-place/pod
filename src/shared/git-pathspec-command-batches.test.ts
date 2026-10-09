import { describe, expect, it } from 'vitest'
import { batchGitPathspecCommands } from './git-pathspec-command-batches'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from './windows-command-line-budget'

describe('batchGitPathspecCommands', () => {
  it('fits valid long Windows paths under the launch budget without dropping paths', () => {
    const leading = ['ls-files', '-z', '--others', '--exclude-standard', '--full-name', '--']
    const pathspecs = Array.from(
      { length: 200 },
      (_, index) => `:(top,literal)dir-${index}-${'x'.repeat(180)}/`
    )
    const measure = (args: readonly string[]) => commandLineLength(['git', ...args])
    expect(measure([...leading, ...pathspecs])).toBeGreaterThan(32_767)

    const commands = batchGitPathspecCommands(leading, pathspecs, {
      maximumPaths: 256,
      commandLineBudget: MAX_COMMAND_LINE_CHARS,
      measureCommandLine: measure
    })

    expect(commands).toHaveLength(2)
    expect(commands.flatMap((args) => args.slice(leading.length))).toEqual(pathspecs)
    for (const args of commands) {
      expect(measure(args)).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
    }
  })

  it('charges transport escaping and preserves a path that cannot fit alone', () => {
    const paths = ['quoted-path'.repeat(10), 'long-path'.repeat(1_000), 'last']
    const commands = batchGitPathspecCommands(['ls-files', '--'], paths, {
      maximumPaths: 256,
      commandLineBudget: 400,
      measureCommandLine: (args) => args.reduce((length, arg) => length + arg.length * 3, 20)
    })

    expect(commands.map((args) => args.slice(2))).toEqual([[paths[0]], [paths[1]], [paths[2]]])
  })

  it('sizes whole commands when the largest transport route changes with argv', () => {
    const paths = Array.from({ length: 200 }, (_, index) => `dir-${index}-${'x'.repeat(90)}/`)
    const measure = (args: readonly string[]) => {
      const bytes = args.reduce((length, arg) => length + arg.length, 0)
      return Math.max(6_600 + bytes, 1_000 + bytes * 3)
    }
    const commands = batchGitPathspecCommands(['ls-files', '--'], paths, {
      maximumPaths: 256,
      commandLineBudget: MAX_COMMAND_LINE_CHARS,
      measureCommandLine: measure
    })

    expect(commands.length).toBeGreaterThan(1)
    expect(commands.flatMap((args) => args.slice(2))).toEqual(paths)
    expect(commands.every((args) => measure(args) <= MAX_COMMAND_LINE_CHARS)).toBe(true)
  })
})
