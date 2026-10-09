import type { StatusPorcelainParser } from '../../../shared/git-status-porcelain-parser'
import {
  expandParsedStatusUntrackedDirectories,
  type UntrackedDirectoryExpansion
} from '../../../shared/git-status-untracked-directory-expansion'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import type { GetStatusOptions } from './get-status-options'

/** List the files under each `? dir/` status row on the same host and admission tier as status. */
export function expandStatusUntrackedDirectories(
  worktreePath: string,
  status: { parser: StatusPorcelainParser; stoppedEarly: boolean },
  limit: number,
  options: GetStatusOptions
): Promise<UntrackedDirectoryExpansion> {
  return expandParsedStatusUntrackedDirectories(status.parser, status.stoppedEarly, {
    limit,
    signal: options.signal,
    listUntracked: (args, onStdout) =>
      gitStreamStdout(args, {
        cwd: worktreePath,
        wslDistro: options.wslDistro,
        admissionTier: options.admissionTier,
        preferWslDirectGit: true,
        env: gitOptionalLocksDisabledEnv(),
        signal: options.signal,
        onStdout
      })
  })
}
