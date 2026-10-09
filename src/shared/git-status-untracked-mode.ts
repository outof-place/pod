import { StatusPorcelainParser } from './git-status-porcelain-parser'
import type { StatusPorcelainRecord } from './git-status-porcelain-parser'

export type GitStatusStdoutStream = (
  args: string[],
  onStdout: (chunk: string) => boolean
) => Promise<{ stoppedEarly: boolean }>

export type ParsedGitStatus = { parser: StatusPorcelainParser; stoppedEarly: boolean }

const MAX_WORKTREES = 128

function untrackedDirectory(record: StatusPorcelainRecord): boolean {
  return (
    record.type === 'entry' && record.entry.area === 'untracked' && record.entry.path.endsWith('/')
  )
}

function untrackedBelowDirectory(record: StatusPorcelainRecord): boolean {
  return (
    record.type === 'entry' && record.entry.area === 'untracked' && record.entry.path.includes('/')
  )
}

async function readStatus(
  args: string[],
  limit: number,
  streamGit: GitStatusStdoutStream,
  parser: StatusPorcelainParser
): Promise<ParsedGitStatus> {
  const { stoppedEarly } = await streamGit(args, (chunk) => parser.update(chunk, limit))
  if (!stoppedEarly) {
    parser.finish()
  }
  return { parser, stoppedEarly }
}

/** Stores a bounded execution-host mode hint, never cached status rows. */
export class GitStatusUntrackedMode {
  private readonly worktrees = new Map<string, { preferNormal: boolean }>()

  constructor(private readonly maximumWorktrees = MAX_WORKTREES) {}

  clear(): void {
    this.worktrees.clear()
  }

  async read(input: {
    key: string
    statusArgs: readonly string[]
    limit: number
    streamGit: GitStatusStdoutStream
    includeIgnored?: boolean
    signal?: AbortSignal
    onParser?: (parser: StatusPorcelainParser) => void
  }): Promise<ParsedGitStatus> {
    input.signal?.throwIfAborted()
    const parser = new StatusPorcelainParser()
    input.onParser?.(parser)
    if (input.includeIgnored) {
      const status = await readStatus([...input.statusArgs], input.limit, input.streamGit, parser)
      input.signal?.throwIfAborted()
      return status
    }
    const previous = this.worktrees.get(input.key)
    const hint = { preferNormal: previous?.preferNormal ?? false }
    this.worktrees.delete(input.key)
    this.worktrees.set(input.key, hint)
    while (this.worktrees.size > this.maximumWorktrees) {
      const oldestKey = this.worktrees.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.worktrees.delete(oldestKey)
    }
    const mode = hint.preferNormal ? 'normal' : 'all'
    const args = input.statusArgs.map((arg) =>
      arg.startsWith('--untracked-files=') ? `--untracked-files=${mode}` : arg
    )
    let status: ParsedGitStatus
    try {
      status = await readStatus(args, input.limit, input.streamGit, parser)
    } catch (error) {
      input.signal?.throwIfAborted()
      if (mode !== 'normal' || !parser.statusRecords.some(untrackedDirectory)) {
        throw error
      }
      // A failed normal scan cannot expose directory rows to a best-effort caller.
      status = { parser, stoppedEarly: true }
    }
    input.signal?.throwIfAborted()
    if (mode === 'normal' && status.parser.statusRecords.some(untrackedDirectory)) {
      // A newly introduced directory needs Git's canonical file rows on this read.
      hint.preferNormal = false
      const canonicalParser = new StatusPorcelainParser()
      input.onParser?.(canonicalParser)
      status = await readStatus(
        [...input.statusArgs],
        input.limit,
        input.streamGit,
        canonicalParser
      )
      input.signal?.throwIfAborted()
    }
    // A newer read, invalidation or eviction owns this slot after an await.
    if (this.worktrees.get(input.key) === hint && !status.stoppedEarly) {
      hint.preferNormal = !status.parser.statusRecords.some(untrackedBelowDirectory)
    }
    return status
  }
}
