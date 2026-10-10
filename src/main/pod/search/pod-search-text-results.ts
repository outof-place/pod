import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import { decodeRipgrepLine } from '../../../shared/ripgrep-line-decoding'
import { ripgrepMatchRanges } from '../../../shared/ripgrep-match-offsets'
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

export function textSearchLimit(options: SearchOptions): number {
  return Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
  )
}

/** The ogd `search` request that answers exactly what buildRgArgs asks ripgrep. */
export function buildOgdSearchRequest(options: SearchOptions, root: string): OgdMessage {
  const includes = options.includePattern
    ? splitSearchGlobPatterns(options.includePattern, 'rg')
    : []
  const excludes = options.excludePattern
    ? splitSearchGlobPatterns(options.excludePattern, 'rg').map((glob) => `!${glob}`)
    : []
  return {
    root,
    pattern: options.query,
    fixed: !options.useRegex,
    // Orca's search has no smart case: unchecked means --ignore-case.
    case: options.caseSensitive ? 'sensitive' : 'insensitive',
    word: options.wholeWord === true,
    // Same globs in rg's argv order (a later glob wins); `!.git` also drops a linked worktree's
    // `.git` file, which ogd's own .git pruning does not cover.
    globs: ['!.git', ...includes, ...excludes],
    hidden: true,
    max_filesize: SEARCH_MAX_FILE_SIZE,
    // Counts submatches as maxResults does; `limit` (lines) is left out so only this applies.
    max_matches: textSearchLimit(options),
    barrier: true
  }
}

/**
 * Builds Orca's SearchResult from an ogd `search` reply in `search.full_lines` form: `text` is
 * the whole line, and for invalid UTF-8 base64 `bytes` carries it and `ranges` index those bytes,
 * so the line decodes exactly as ripgrep's JSON does. Null when a line was clipped.
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
  const markTruncated = (): void => {
    acc.truncated = true
  }
  for (const match of matches) {
    if (!isOgdMessage(match) || typeof match.path !== 'string' || !Array.isArray(match.ranges)) {
      markTruncated()
      continue
    }
    const text = typeof match.text === 'string' ? match.text : undefined
    const bytes = typeof match.bytes === 'string' ? match.bytes : undefined
    if (match.clipped === true) {
      return null
    }
    if (text === undefined && bytes === undefined) {
      markTruncated()
      continue
    }
    const submatches: { start: number; end: number }[] = []
    for (const range of match.ranges) {
      if (Array.isArray(range) && typeof range[0] === 'number' && typeof range[1] === 'number') {
        submatches.push({ start: range[0], end: range[1] })
      } else {
        markTruncated()
      }
    }
    if (submatches.length === 0 && match.ranges.length > 0) {
      continue
    }
    const relativePath = normalizeRelativePath(match.path, resultRootPath)
    const filePath = joinSearchRoot(resultRootPath, relativePath)
    let fileResult = acc.fileMap.get(filePath)
    if (!fileResult) {
      fileResult = { filePath, relativePath, matches: [], matchCount: 0 }
      acc.fileMap.set(filePath, fileResult)
    }
    // With `bytes`, `text` is lossy and the ranges index the raw bytes.
    const { text: lineContent, readOffset } = decodeRipgrepLine(
      bytes === undefined ? { text } : { bytes }
    )
    for (const sub of ripgrepMatchRanges(lineContent, submatches, readOffset, markTruncated)) {
      const verdict = pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent,
        matchStart: sub.start,
        matchLength: sub.end - sub.start,
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
