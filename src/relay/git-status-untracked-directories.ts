import type { StatusPorcelainParser } from '../shared/git-status-porcelain-parser'
import {
  expandParsedStatusUntrackedDirectories,
  type UntrackedDirectoryExpansion
} from '../shared/git-status-untracked-directory-expansion'
import type { RelayGitStreamExec } from './git-stdout-stream'

/** List the files under each `? dir/` status row on the relay host. */
export function expandRelayStatusUntrackedDirectories(
  streamGit: RelayGitStreamExec,
  status: { parser: StatusPorcelainParser; stoppedEarly: boolean },
  { worktreePath, limit, signal }: { worktreePath: string; limit: number; signal?: AbortSignal }
): Promise<UntrackedDirectoryExpansion> {
  return expandParsedStatusUntrackedDirectories(status.parser, status.stoppedEarly, {
    limit,
    signal,
    listUntracked: (args, onStdout) =>
      streamGit(args, worktreePath, { disableOptionalLocks: true, signal, onStdout })
  })
}
