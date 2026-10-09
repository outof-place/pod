import type { StatusPorcelainParser } from '../../../shared/git-status-porcelain-parser'
import {
  expandParsedStatusUntrackedDirectories,
  buildUntrackedDirectoryListingCommands,
  type UntrackedDirectoryListingStream,
  type ParsedGitStatus
} from '../../../shared/git-status-untracked-directory-expansion'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import {
  isStatusRepositoryRoot,
  readAllStatusAfterExpansionFailure
} from '../../../shared/git-status-stream-read'
import { finishedGitCommandLineLength } from './git-pathspec'
import { nativeGitCommandLineLength } from '../../../shared/git-pathspec-command-batches'

/** List the files under each `? dir/` status row on the same host and admission tier as status. */
export function expandStatusUntrackedDirectories(
  worktreePath: string,
  status: { parser: StatusPorcelainParser; stoppedEarly: boolean },
  limit: number,
  options: GetStatusOptions,
  statusArgs: readonly string[]
): Promise<ParsedGitStatus> {
  const streamGit: UntrackedDirectoryListingStream = (args, onStdout) =>
    gitStreamStdout(args, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      admissionTier: options.admissionTier,
      preferWslDirectGit: true,
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout
    })
  return expandParsedStatusUntrackedDirectories(status.parser, status.stoppedEarly, {
    limit,
    includeIgnored: options.includeIgnored,
    signal: options.signal,
    listUntracked: streamGit,
    listingCommands: (directories) =>
      buildUntrackedDirectoryListingCommands(directories, (args) =>
        process.platform === 'win32'
          ? finishedGitCommandLineLength(args, worktreePath, options, {
              preferWslDirectGit: true,
              env: gitOptionalLocksDisabledEnv()
            })
          : nativeGitCommandLineLength(args)
      ),
    isRepositoryRoot: () => isStatusRepositoryRoot(streamGit),
    readAllStatus: () => readAllStatusAfterExpansionFailure(statusArgs, limit, streamGit)
  })
}
