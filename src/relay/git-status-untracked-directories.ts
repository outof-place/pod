import type { StatusPorcelainParser } from '../shared/git-status-porcelain-parser'
import {
  expandParsedStatusUntrackedDirectories,
  type ParsedGitStatus
} from '../shared/git-status-untracked-directory-expansion'
import {
  isStatusRepositoryRoot,
  readAllStatusAfterExpansionFailure
} from '../shared/git-status-stream-read'
import type { RelayGitStreamExec } from './git-stdout-stream'

/** List the files under each `? dir/` status row on the relay host. */
export function expandRelayStatusUntrackedDirectories(
  streamGit: RelayGitStreamExec,
  status: { parser: StatusPorcelainParser; stoppedEarly: boolean },
  { worktreePath, limit, signal }: { worktreePath: string; limit: number; signal?: AbortSignal },
  statusArgs: readonly string[]
): Promise<ParsedGitStatus> {
  const listUntracked = (args: string[], onStdout: (chunk: string) => boolean) =>
    streamGit(args, worktreePath, { disableOptionalLocks: true, signal, onStdout })
  return expandParsedStatusUntrackedDirectories(status.parser, status.stoppedEarly, {
    limit,
    includeIgnored: statusArgs.includes('--untracked-files=all'),
    signal,
    listUntracked,
    isRepositoryRoot: () => isStatusRepositoryRoot(listUntracked),
    readAllStatus: () => readAllStatusAfterExpansionFailure(statusArgs, limit, listUntracked)
  })
}
