import type { GitStatusEntry } from './git-status-types'
import type { StatusPorcelainParser, StatusPorcelainRecord } from './git-status-porcelain-parser'
import { batchGitPathspecCommands } from './git-pathspec-command-batches'
import { GIT_OUTPUT_MAX_BYTES } from './git-output-byte-limit'

// Optional-locks-off polls can reuse the cache a terminal's normal-mode status writes.
export function statusUntrackedFilesArg(includeIgnored: boolean): string {
  // Ignored rows depend on directory collapsing, so preserve all mode for those reads.
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

export type ParsedGitStatus = UntrackedDirectoryExpansion & { parser: StatusPorcelainParser }

const PATHSPECS_PER_LISTING = 256

export function buildUntrackedDirectoryListingArgs(directories: readonly string[]): string[] {
  // Only repository-root status reads reach this listing.
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

export function buildUntrackedDirectoryListingCommands(
  directories: readonly string[],
  measureCommandLine?: (args: readonly string[]) => number
): string[][] {
  const args = buildUntrackedDirectoryListingArgs(directories)
  return batchGitPathspecCommands(args.slice(0, 6), args.slice(6), {
    maximumPaths: PATHSPECS_PER_LISTING,
    measureCommandLine
  })
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

/** Expand collapsed directory rows in order, preserving nested repository rows. */
export async function expandUntrackedDirectoryRecords(input: {
  records: readonly StatusPorcelainRecord[]
  limit: number
  listUntracked: UntrackedDirectoryListingStream
  listingCommands?: (directories: readonly string[]) => string[][]
}): Promise<UntrackedDirectoryExpansion | null> {
  const directories = input.records.flatMap((record) => collapsedUntrackedDirectory(record) ?? [])
  if (directories.length === 0) {
    return null
  }
  const directorySet = new Set(directories)
  const filesByDirectory = new Map<string, GitStatusEntry[]>()
  const fixedBeforeDirectory = new Map<string, number>()
  let fixedCount = 0
  for (const record of input.records) {
    const directory = collapsedUntrackedDirectory(record)
    if (directory === null) {
      fixedCount += 1
    } else {
      fixedBeforeDirectory.set(directory, fixedCount)
    }
  }
  let listedCount = 0
  let outputBytes = 0
  let stoppedEarly = false

  const commands = (input.listingCommands ?? buildUntrackedDirectoryListingCommands)(directories)
  for (const args of commands) {
    let carry = ''
    const result = await input.listUntracked(args, (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > GIT_OUTPUT_MAX_BYTES) {
        throw new Error('Untracked file listing exceeded the Git output byte limit.')
      }
      const parts = (carry + chunk).split('\0')
      // NUL terminates every path; only the last part can be incomplete.
      carry = parts.pop() ?? ''
      for (const path of parts) {
        if (!path) {
          continue
        }
        const directory = findOwningDirectory(path, directorySet)
        if (!directory) {
          throw new Error(
            'Untracked file listing returned a path outside the requested directories.'
          )
        }
        let files = filesByDirectory.get(directory)
        if (!files) {
          files = []
          filesByDirectory.set(directory, files)
        }
        files.push({ path, status: 'untracked', area: 'untracked' })
        listedCount += 1
        // Later fixed rows must not consume the budget before this directory's files.
        const count = listedCount + (fixedBeforeDirectory.get(directory) ?? 0)
        if (input.limit !== 0 && count > input.limit) {
          return true
        }
      }
      return false
    })
    stoppedEarly = result.stoppedEarly
    if (stoppedEarly) {
      break
    }
    if (carry) {
      throw new Error('Untracked file listing ended with an incomplete path.')
    }
  }

  const records: StatusPorcelainRecord[] = []
  for (const record of input.records) {
    const directory = collapsedUntrackedDirectory(record)
    if (directory === null) {
      records.push(record)
      continue
    }
    // A vanished or newly ignored directory has no remaining untracked rows.
    for (const entry of filesByDirectory.get(directory) ?? []) {
      records.push({ type: 'entry', entry })
    }
  }
  const exceededLimit = input.limit !== 0 && records.length > input.limit
  return {
    records: exceededLimit ? records.slice(0, input.limit + 1) : records,
    stoppedEarly: stoppedEarly || exceededLimit,
    statusLength: exceededLimit ? input.limit + 1 : records.length
  }
}

/**
 * Retry all-mode status after a listing failure so callers always receive file rows.
 */
export async function expandParsedStatusUntrackedDirectories(
  parser: StatusPorcelainParser,
  stoppedEarly: boolean,
  input: {
    limit: number
    includeIgnored?: boolean
    listUntracked: UntrackedDirectoryListingStream
    listingCommands?: (directories: readonly string[]) => string[][]
    isRepositoryRoot: () => Promise<boolean>
    readAllStatus: () => Promise<ParsedGitStatus>
    signal?: AbortSignal
  }
): Promise<ParsedGitStatus> {
  const collapsed = {
    parser,
    records: parser.statusRecords,
    stoppedEarly,
    statusLength: parser.statusLength
  }
  if (input.includeIgnored) {
    return collapsed
  }
  const directories = parser.statusRecords.flatMap(
    (record) => collapsedUntrackedDirectory(record) ?? []
  )
  if (directories.length === 0) {
    return collapsed
  }
  // Nested status honors user path settings; keep Git's canonical all-mode rows.
  if (directories.some((directory) => directory === './' || directory.startsWith('../'))) {
    return input.readAllStatus()
  }
  try {
    if (!(await input.isRepositoryRoot())) {
      return input.readAllStatus()
    }
    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      ...input
    })
    return expansion
      ? {
          parser,
          records: expansion.records,
          stoppedEarly: stoppedEarly || expansion.stoppedEarly,
          statusLength: Math.max(parser.statusLength, expansion.statusLength)
        }
      : collapsed
  } catch (error) {
    if (input.signal?.aborted) {
      throw error
    }
    return input.readAllStatus()
  }
}
