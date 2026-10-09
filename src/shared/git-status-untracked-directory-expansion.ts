import type { GitStatusEntry } from './git-status-types'
import type { StatusPorcelainParser, StatusPorcelainRecord } from './git-status-porcelain-parser'

/**
 * Why normal mode plus expansion instead of `--untracked-files=all`: Git only serves `all`
 * from the index's untracked cache when the cache was last written in `all` mode. Status
 * polls run with optional locks off, so they never write it, and any plain `git status`
 * in the terminal rewrites it in normal mode. Every `all` poll then walks the whole tree
 * (~70-80 ms of `read_directory` on an 18k-file repo), while normal mode answers from the
 * cache (~6 ms). Normal mode collapses each untracked directory to one `? dir/` row, so a
 * pathspec-scoped `ls-files --others` recovers exactly the per-file rows `all` lists.
 */
export function statusUntrackedFilesArg(includeIgnored: boolean): string {
  // Why: ignored rows under an untracked directory depend on how that directory is
  // collapsed, so the ignored listing keeps `all` to stay byte-identical.
  return includeIgnored ? '--untracked-files=all' : '--untracked-files=normal'
}

/** Streams `git <args>` stdout; `onStdout` returns true to stop the child early. */
export type UntrackedDirectoryListingStream = (
  args: string[],
  onStdout: (chunk: string) => boolean
) => Promise<{ stoppedEarly: boolean }>

export type UntrackedDirectoryExpansion = {
  records: StatusPorcelainRecord[]
  stoppedEarly: boolean
  /** Changed-entry count after expansion, including any past the limit. */
  statusLength: number
}

// Why: keeps argv well under every host's ARG_MAX even for repos with many new folders.
const PATHSPECS_PER_LISTING = 256

export function buildUntrackedDirectoryListingArgs(directories: readonly string[]): string[] {
  // Why: `top` anchors pathspecs at the repo root like status paths; `literal` keeps
  // glob characters in directory names from matching siblings. Both predate Git 2.25.
  return [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    '--full-name',
    '--',
    ...directories.map((directory) => `:(top,literal)${directory}`)
  ]
}

function collapsedUntrackedDirectory(record: StatusPorcelainRecord): string | null {
  return record.type === 'entry' &&
    record.entry.area === 'untracked' &&
    record.entry.path.endsWith('/')
    ? record.entry.path
    : null
}

function findOwningDirectory(path: string, directories: ReadonlySet<string>): string | null {
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
    const prefix = path.slice(0, slash + 1)
    if (directories.has(prefix)) {
      return prefix
    }
  }
  return null
}

/**
 * Replace each `? dir/` row with the untracked files Git lists under it, in place, so the
 * result matches `--untracked-files=all` row for row. Nested repositories come back as
 * their own `dir/` row, exactly as `all` reports them. Returns null when nothing is
 * collapsed, so the common clean or files-only status costs no extra Git process.
 */
export async function expandUntrackedDirectoryRecords(input: {
  records: readonly StatusPorcelainRecord[]
  limit: number
  listUntracked: UntrackedDirectoryListingStream
}): Promise<UntrackedDirectoryExpansion | null> {
  const directories = input.records.flatMap((record) => collapsedUntrackedDirectory(record) ?? [])
  if (directories.length === 0) {
    return null
  }
  const directorySet = new Set(directories)
  const filesByDirectory = new Map<string, GitStatusEntry[]>()
  let count = input.records.length - directories.length
  let stoppedEarly = false

  for (let start = 0; start < directories.length && !stoppedEarly; start += PATHSPECS_PER_LISTING) {
    let carry = ''
    const result = await input.listUntracked(
      buildUntrackedDirectoryListingArgs(directories.slice(start, start + PATHSPECS_PER_LISTING)),
      (chunk) => {
        const parts = (carry + chunk).split('\0')
        // Why: -z terminates every path, so the last part is either '' or a path split across chunks.
        carry = parts.pop() ?? ''
        for (const path of parts) {
          const directory = path ? findOwningDirectory(path, directorySet) : null
          if (!directory) {
            continue
          }
          let files = filesByDirectory.get(directory)
          if (!files) {
            files = []
            filesByDirectory.set(directory, files)
          }
          files.push({ path, status: 'untracked', area: 'untracked' })
          count += 1
          if (input.limit !== 0 && count > input.limit) {
            return true
          }
        }
        return false
      }
    )
    stoppedEarly = result.stoppedEarly
  }

  const records: StatusPorcelainRecord[] = []
  for (const record of input.records) {
    const directory = collapsedUntrackedDirectory(record)
    if (directory === null) {
      records.push(record)
      continue
    }
    // Why no fallback row: a directory Git no longer lists (deleted, or now fully ignored)
    // has no untracked files, which is what `all` would report at this moment.
    for (const entry of filesByDirectory.get(directory) ?? []) {
      records.push({ type: 'entry', entry })
    }
  }
  return { records, stoppedEarly, statusLength: count }
}

/**
 * Expand a finished status parse, falling back to its collapsed rows if the listing fails:
 * a status that already succeeded should not fail on the follow-up read.
 */
export async function expandParsedStatusUntrackedDirectories(
  parser: StatusPorcelainParser,
  stoppedEarly: boolean,
  input: { limit: number; listUntracked: UntrackedDirectoryListingStream; signal?: AbortSignal }
): Promise<UntrackedDirectoryExpansion> {
  const collapsed = {
    records: parser.statusRecords,
    stoppedEarly,
    statusLength: parser.statusLength
  }
  try {
    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      ...input
    })
    return expansion
      ? {
          records: expansion.records,
          stoppedEarly: stoppedEarly || expansion.stoppedEarly,
          statusLength: Math.max(parser.statusLength, expansion.statusLength)
        }
      : collapsed
  } catch (error) {
    if (input.signal?.aborted) {
      throw error
    }
    return collapsed
  }
}
