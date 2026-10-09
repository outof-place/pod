import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import { createRipgrepOffsetReader } from '../../../shared/ripgrep-match-offsets'
import {
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize
} from '../../../shared/text-search'
import { splitSearchGlobPatterns } from '../../../shared/text-search-glob-patterns'
import { pushSearchMatch } from '../../../shared/text-search-match-accumulator'
import { joinSearchRoot, normalizeRelativePath } from '../../../shared/text-search-paths'
import { isOgdMessage, type OgdMessage } from './ogd-connection'

// Mirrors buildRgArgs' `--max-filesize 5M`.
const SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024
// ogd cuts `text` at this many bytes and only reports the ranges inside the cut.
const OGD_LINE_EXCERPT_BYTES = 2000

/** A line ogd clipped, or decoded lossily, has ranges that cannot match ripgrep's exactly. */
function isInexactOgdLine(text: string, match: OgdMessage): boolean {
  return (
    match.clipped === true ||
    Buffer.byteLength(text, 'utf8') >= OGD_LINE_EXCERPT_BYTES ||
    text.includes('\uFFFD')
  )
}

export function textSearchLimit(options: SearchOptions): number {
  return Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
  )
}

export function buildOgdSearchRequest(
  options: SearchOptions,
  root: string
): { fields: OgdMessage; hasNegatedGlobs: boolean } {
  const includes = options.includePattern
    ? splitSearchGlobPatterns(options.includePattern, 'rg')
    : []
  const excludes = options.excludePattern
    ? splitSearchGlobPatterns(options.excludePattern, 'rg').map((glob) => `!${glob}`)
    : []
  return {
    fields: {
      root,
      pattern: options.query,
      fixed: !options.useRegex,
      // Orca's search has no smart case: unchecked means --ignore-case.
      case: options.caseSensitive ? 'sensitive' : 'insensitive',
      word: options.wholeWord === true,
      globs: [...includes, ...excludes],
      // rg runs with --hidden --glob !.git; the daemon never indexes .git.
      hidden: true,
      max_filesize: SEARCH_MAX_FILE_SIZE,
      limit: textSearchLimit(options),
      barrier: true
    },
    hasNegatedGlobs: excludes.length > 0
  }
}

/**
 * Builds Orca's SearchResult from an ogd `search` reply. `ranges` are byte offsets into `text`,
 * converted to UTF-16 columns exactly as ripgrep's JSON submatches are. Null when a matched line
 * was clipped or lossily decoded, so ripgrep answers instead of silently dropping matches.
 */
export function ogdSearchReplyToResult(
  reply: OgdMessage,
  resultRootPath: string,
  options: SearchOptions
): SearchResult | null {
  const matches = reply.matches
  if (!Array.isArray(matches)) {
    return null
  }
  const maxResults = textSearchLimit(options)
  const acc = createAccumulator()
  for (const match of matches) {
    if (!isOgdMessage(match) || typeof match.path !== 'string' || typeof match.text !== 'string') {
      acc.truncated = true
      continue
    }
    if (isInexactOgdLine(match.text, match)) {
      return null
    }
    const relativePath = normalizeRelativePath(match.path, resultRootPath)
    const filePath = joinSearchRoot(resultRootPath, relativePath)
    let fileResult = acc.fileMap.get(filePath)
    if (!fileResult) {
      fileResult = { filePath, relativePath, matches: [], matchCount: 0 }
      acc.fileMap.set(filePath, fileResult)
    }
    const readOffset = createRipgrepOffsetReader(match.text)
    const ranges = Array.isArray(match.ranges) ? match.ranges : []
    for (const range of ranges) {
      const start =
        Array.isArray(range) && typeof range[0] === 'number' ? readOffset(range[0]) : null
      const end = Array.isArray(range) && typeof range[1] === 'number' ? readOffset(range[1]) : null
      if (start === null || end === null) {
        // A range outside its own line is a daemon fault; report a partial page, not a wrong one.
        acc.truncated = true
        continue
      }
      const verdict = pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent: match.text,
        matchStart: start,
        matchLength: end - start,
        lineNumber: typeof match.line === 'number' ? match.line : 0,
        maxResults
      })
      if (verdict === 'stop') {
        return finalize(acc)
      }
    }
  }
  for (const [filePath, fileResult] of acc.fileMap) {
    if (fileResult.matches.length === 0) {
      acc.fileMap.delete(filePath)
    }
  }
  if (reply.truncated === true) {
    acc.truncated = true
  }
  return finalize(acc)
}
