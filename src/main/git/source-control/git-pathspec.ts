import { commandLineLength } from '../../../shared/windows-command-line-budget'
import {
  batchGitPathspecCommands,
  gitCommandLineBudget
} from '../../../shared/git-pathspec-command-batches'
import {
  resolveGitCommand,
  resolveGitCommandWithoutProbe
} from '../command-runner/git-command-resolution'
import type { GitRuntimeOptions } from '../git-runtime-options'

/** Ceiling on argv entries per invocation; under WSL the byte budget bites first. */
const BULK_CHUNK_SIZE = 100

export function literalPathspec(filePath: string, options: GitRuntimeOptions): string {
  // Why: Git inside WSL needs POSIX paths, but host paths must stay literal, so convert backslashes only for WSL.
  const runtimePath = options.wslDistro ? filePath.replace(/\\/g, '/') : filePath
  return `:(literal)${runtimePath}`
}

/** Budget both WSL read routes so a direct-route failure can still use the login shell. */
export function finishedGitCommandLineLength(
  args: readonly string[],
  worktreePath: string,
  options: GitRuntimeOptions,
  readOptions?: { preferWslDirectGit: true; env: NodeJS.ProcessEnv }
): number {
  const resolved = resolveGitCommandWithoutProbe([...args], {
    cwd: worktreePath,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
  })
  const fallbackLength = commandLineLength([resolved.binary, ...resolved.args])
  if (!readOptions) {
    return fallbackLength
  }
  // Direct WSL reads also put the cached PATH and HOME on Windows' command line.
  const direct = resolveGitCommand([...args], { cwd: worktreePath, ...options, ...readOptions })
  return Math.max(fallbackLength, commandLineLength([direct.binary, ...direct.args]))
}

/** Preserve whole pathspecs while bounding the resolved host command line. */
export function bulkPathspecCommands(
  leadingArgs: readonly string[],
  filePaths: readonly string[],
  worktreePath: string,
  options: GitRuntimeOptions
): string[][] {
  // Budget belongs to the host that spawns; the overhead measured above belongs to the transport.
  const budget = gitCommandLineBudget()
  return batchGitPathspecCommands(
    leadingArgs,
    filePaths.map((filePath) => literalPathspec(filePath, options)),
    {
      maximumPaths: BULK_CHUNK_SIZE,
      commandLineBudget: budget,
      measureCommandLine: (args) => finishedGitCommandLineLength(args, worktreePath, options)
    }
  )
}
