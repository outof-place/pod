import type { OgdClient } from './ogd-client'
import { quickOpenRipgrepGlobs } from './pod-search-listing'

// Optional daemon capabilities, advertised in the hello `features` list. Without them the
// matching requests stay on ripgrep, because the results would not be the same.
// `ignored:true` lists the set of `rg --files --no-ignore-vcs --hidden`.
export const OGD_FEATURE_FILES_IGNORED = 'files.ignored'
export const OGD_FEATURE_FUZZY_IGNORED = 'fuzzy.ignored'
// `globs` with rg `-g` semantics, so the daemon prunes exactly like ripgrep's quick-open walk.
export const OGD_FEATURE_FILES_GLOBS = 'files.globs'
export const OGD_FEATURE_FUZZY_GLOBS = 'fuzzy.globs'
// `exclude` root-relative prefixes, which also keep ogd's ignored-dir cache warm below them.
export const OGD_FEATURE_FILES_EXCLUDE = 'files.exclude'
export const OGD_FEATURE_FUZZY_EXCLUDE = 'fuzzy.exclude'
// Whole lines and ranges into them, matched by ripgrep's own searcher (case, -w, BOM).
export const OGD_FEATURE_SEARCH_FULL_LINES = 'search.full_lines'
export const OGD_FEATURE_SEARCH_MAX_FILESIZE = 'search.max_filesize'
export const OGD_FEATURE_SEARCH_MAX_MATCHES = 'search.max_matches'
// `globs` with rg `-g` semantics, `!` negations included.
export const OGD_FEATURE_SEARCH_NEGATED_GLOBS = 'search.negated_globs'
// Binary files quit at the first NUL anywhere, as rg does.
export const OGD_FEATURE_SEARCH_BINARY = 'search.binary'
/** Text search equals buildRgArgs' ripgrep run only with every one of these. */
export const OGD_TEXT_SEARCH_FEATURES = [
  OGD_FEATURE_SEARCH_FULL_LINES,
  OGD_FEATURE_SEARCH_MAX_FILESIZE,
  OGD_FEATURE_SEARCH_MAX_MATCHES,
  OGD_FEATURE_SEARCH_NEGATED_GLOBS,
  OGD_FEATURE_SEARCH_BINARY
]

/** Quick-open scan fields: rg's blocklist and nested-worktree globs, plus the prefixes. */
export function quickOpenScanFields(
  client: OgdClient,
  op: 'files' | 'fuzzy',
  excludePathPrefixes: readonly string[]
): Record<string, unknown> {
  const globs = op === 'files' ? OGD_FEATURE_FILES_GLOBS : OGD_FEATURE_FUZZY_GLOBS
  const exclude = op === 'files' ? OGD_FEATURE_FILES_EXCLUDE : OGD_FEATURE_FUZZY_EXCLUDE
  return {
    ...(client.hasFeature(globs) ? { globs: quickOpenRipgrepGlobs(excludePathPrefixes) } : {}),
    ...(client.hasFeature(exclude) && excludePathPrefixes.length > 0
      ? { exclude: excludePathPrefixes }
      : {})
  }
}

// Why globs too: without the blocklist the ignored pass walks node_modules (seconds, not ms).
export function servesIgnoredScan(client: OgdClient, op: 'files' | 'fuzzy'): boolean {
  return op === 'files'
    ? client.hasFeature(OGD_FEATURE_FILES_IGNORED) && client.hasFeature(OGD_FEATURE_FILES_GLOBS)
    : client.hasFeature(OGD_FEATURE_FUZZY_IGNORED) && client.hasFeature(OGD_FEATURE_FUZZY_GLOBS)
}
