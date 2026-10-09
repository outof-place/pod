import { FileInventoryBudget } from '../../../shared/file-inventory-budget'
import { buildRgArgsForQuickOpen } from '../../../shared/quick-open-filter'
import { quickOpenListingPathFilter } from '../../../shared/quick-open-listing-path-filter'
import {
  limitQuickOpenFilesBySerializedBytes,
  serializedQuickOpenPathBytes
} from '../../../shared/quick-open-transport-budget'
import type { ExternalFileListRequest } from '../../search/external-workspace-search-provider'

/**
 * The `--glob` values ripgrep's quick-open listing uses (blocklist and nested-worktree pruning),
 * for a daemon that applies `globs` with rg `-g` semantics.
 */
export function quickOpenRipgrepGlobs(excludePathPrefixes: readonly string[]): string[] {
  const { primary } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes,
    forceSlashSeparator: false
  })
  return primary.filter((_arg, index) => primary[index - 1] === '--glob')
}

/** ogd `files` attachment: `\n`-separated root-relative paths in component order. */
export function decodeOgdPathList(binary: Buffer | null): string[] {
  if (!binary || binary.length === 0) {
    return []
  }
  return binary
    .toString('utf8')
    .split('\n')
    .filter((path) => path.length > 0)
}

/**
 * Applies the listing contract of the ripgrep path to daemon output: the quick-open blocklist,
 * nested-worktree prefixes, the caller's filter, then the result, byte and inventory budgets.
 */
export function collectQuickOpenListing(
  paths: Iterable<string>,
  request: Pick<
    ExternalFileListRequest,
    'excludePathPrefixes' | 'maxResults' | 'maxSerializedBytes' | 'pathFilter'
  >
): string[] {
  const includePath = quickOpenListingPathFilter(request.excludePathPrefixes)
  const inventoryBudget =
    request.maxResults === undefined && request.maxSerializedBytes === undefined
      ? new FileInventoryBudget()
      : null
  const files = new Set<string>()
  let serializedBytes = 2 // []
  for (const path of paths) {
    if (request.maxResults !== undefined && files.size >= request.maxResults) {
      break
    }
    if (
      !includePath(path) ||
      (request.pathFilter && !request.pathFilter(path)) ||
      files.has(path)
    ) {
      continue
    }
    if (request.maxSerializedBytes !== undefined) {
      const nextBytes = serializedQuickOpenPathBytes(path) + (files.size === 0 ? 0 : 1)
      if (serializedBytes + nextBytes > request.maxSerializedBytes) {
        break
      }
      serializedBytes += nextBytes
    }
    // Throws FileInventoryCapacityError, the same failure the ripgrep path reports.
    inventoryBudget?.record(path)
    files.add(path)
  }
  const result = Array.from(files)
  return request.maxSerializedBytes === undefined
    ? result
    : limitQuickOpenFilesBySerializedBytes(result, request.maxSerializedBytes)
}
