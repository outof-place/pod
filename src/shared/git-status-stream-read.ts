import { StatusPorcelainParser } from './git-status-porcelain-parser'
import type {
  ParsedGitStatus,
  UntrackedDirectoryListingStream
} from './git-status-untracked-directory-expansion'

/** Preserve branch metadata and the same output cap when retrying a status read. */
export async function readAllStatusAfterExpansionFailure(
  statusArgs: readonly string[],
  limit: number,
  streamGit: UntrackedDirectoryListingStream
): Promise<ParsedGitStatus> {
  const parser = new StatusPorcelainParser()
  const args = statusArgs.map((arg) =>
    arg.startsWith('--untracked-files=') ? '--untracked-files=all' : arg
  )
  const { stoppedEarly } = await streamGit(args, (chunk) => parser.update(chunk, limit))
  if (!stoppedEarly) {
    parser.finish()
  }
  return {
    parser,
    records: parser.statusRecords,
    stoppedEarly,
    statusLength: parser.statusLength
  }
}

/** Resolve the polling cwd on its execution host without changing status path settings. */
export async function isStatusRepositoryRoot(
  streamGit: UntrackedDirectoryListingStream
): Promise<boolean> {
  let prefix = ''
  const { stoppedEarly } = await streamGit(['rev-parse', '--show-prefix'], (chunk) => {
    prefix += chunk
    if (Buffer.byteLength(prefix) > 4_096) {
      throw new Error('Git repository prefix exceeded the output byte limit.')
    }
    return false
  })
  return !stoppedEarly && (prefix === '' || prefix === '\n' || prefix === '\r\n')
}
