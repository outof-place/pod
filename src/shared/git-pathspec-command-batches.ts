import { commandLineLength, MAX_COMMAND_LINE_CHARS } from './windows-command-line-budget'

const POSIX_COMMAND_LINE_BUDGET = 128_000

export function gitCommandLineBudget(): number {
  return process.platform === 'win32' ? MAX_COMMAND_LINE_CHARS : POSIX_COMMAND_LINE_BUDGET
}

export function nativeGitCommandLineLength(args: readonly string[]): number {
  return process.platform === 'win32'
    ? commandLineLength(['git', ...args])
    : args.reduce((length, arg) => length + Buffer.byteLength(arg) + 1, 4)
}

/** Budget encoded pathspecs using the command the execution host actually launches. */
export function batchGitPathspecCommands(
  leadingArgs: readonly string[],
  pathspecs: readonly string[],
  options: {
    maximumPaths: number
    commandLineBudget?: number
    measureCommandLine?: (args: readonly string[]) => number
  }
): string[][] {
  const budget = options.commandLineBudget ?? gitCommandLineBudget()
  const measure = options.measureCommandLine ?? nativeGitCommandLineLength
  const commands: string[][] = []
  let start = 0
  while (start < pathspecs.length) {
    let end = Math.min(start + options.maximumPaths, pathspecs.length)
    if (measure([...leadingArgs, ...pathspecs.slice(start, end)]) > budget) {
      let lower = start + 1
      let upper = end
      // Whole-command sizing also handles transports whose largest route changes with argv.
      while (lower < upper) {
        const candidate = Math.ceil((lower + upper) / 2)
        if (measure([...leadingArgs, ...pathspecs.slice(start, candidate)]) <= budget) {
          lower = candidate
        } else {
          upper = candidate - 1
        }
      }
      end = lower
    }
    commands.push([...leadingArgs, ...pathspecs.slice(start, end)])
    start = end
  }
  return commands
}
