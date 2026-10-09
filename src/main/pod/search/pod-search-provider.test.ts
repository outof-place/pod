import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileListingCancelledError } from '../../../shared/file-listing-cancellation'
import type { ExternalFileListRequest } from '../../search/external-workspace-search-provider'
import { OgdClient } from './ogd-client'
import type { OgdMessage } from './ogd-connection'
import { startOgdMockServer, type OgdMockReply, type OgdMockServer } from './ogd-mock-server'
import {
  createPodSearchProvider,
  OGD_FEATURE_FILES_EXCLUDE,
  OGD_FEATURE_FILES_IGNORED,
  OGD_FEATURE_FUZZY_EXCLUDE,
  OGD_FEATURE_SEARCH_FULL_LINES,
  OGD_FEATURE_SEARCH_MAX_FILESIZE,
  OGD_FEATURE_SEARCH_NEGATED_GLOBS
} from './pod-search-provider'

let repo: string
let plainFolder: string
let mock: OgdMockServer | null = null
let ogd: OgdClient | null = null

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pod-search-')))
  repo = join(base, 'repo')
  plainFolder = join(base, 'folder')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(plainFolder)
})

afterEach(async () => {
  ogd?.close()
  ogd = null
  await mock?.close()
  mock = null
  rmSync(join(repo, '..'), { recursive: true, force: true })
})

async function provider(
  handle: (request: OgdMessage) => OgdMockReply,
  options: { features?: string[]; enabled?: boolean } = {}
) {
  mock = await startOgdMockServer({
    features: options.features ?? [],
    handle: (request) => (request.op === 'register' ? { message: {} } : handle(request))
  })
  ogd = new OgdClient({ socketPath: mock.socketPath, client: 'orca/test', timeoutMs: 500 })
  const client = ogd
  return createPodSearchProvider({ isEnabled: () => options.enabled ?? true, client: () => client })
}

function listRequest(overrides: Partial<ExternalFileListRequest> = {}): ExternalFileListRequest {
  return {
    rootPath: repo,
    excludePathPrefixes: [],
    includeIgnored: false,
    followSymlinks: false,
    ...overrides
  }
}

const LISTING = [
  'src/a.ts',
  'node_modules/x/index.js',
  '.vscode/settings.json',
  'nested/wt/b.ts',
  'README.md'
]

describe('Pod search provider: listing', () => {
  it('serves the tracked listing with the quick-open blocklist and nested worktrees removed', async () => {
    const search = await provider(() => ({
      message: { count: LISTING.length },
      binary: Buffer.from(LISTING.join('\n'))
    }))
    const files = await search.listFiles(listRequest({ excludePathPrefixes: ['nested/wt'] }))
    expect(files).toEqual(['src/a.ts', 'README.md'])
    expect(mock?.requests.map((request) => request.op)).toEqual(['register', 'files'])
    expect(mock?.requests[1]).toMatchObject({ root: repo, hidden: true, barrier: true })
  })

  it('applies the caller cap and filter like the ripgrep path', async () => {
    const search = await provider(() => ({ message: {}, binary: Buffer.from(LISTING.join('\n')) }))
    expect(
      await search.listFiles(
        listRequest({ maxResults: 1, pathFilter: (path) => path.endsWith('.md') })
      )
    ).toEqual(['README.md'])
  })

  it('leaves ignored files to ripgrep unless the daemon can list them', async () => {
    const reply = (): OgdMockReply => ({
      message: {},
      binary: Buffer.from('src/a.ts\ndist/out.js')
    })
    const without = await provider(reply)
    expect(await without.listFiles(listRequest({ includeIgnored: true }))).toBeNull()
    await mock?.close()
    ogd?.close()
    const withIgnored = await provider(reply, { features: [OGD_FEATURE_FILES_IGNORED] })
    expect(await withIgnored.listFiles(listRequest({ includeIgnored: true }))).toEqual([
      'src/a.ts',
      'dist/out.js'
    ])
    expect(mock?.requests.at(-1)).toMatchObject({ op: 'files', ignored: true })
  })

  it('falls back on symlink following, recent-file validation and a disabled engine', async () => {
    const search = await provider(() => ({ message: {}, binary: Buffer.from('a') }))
    expect(await search.listFiles(listRequest({ followSymlinks: true }))).toBeNull()
    expect(await search.listFiles(listRequest({ candidatePaths: ['a'] }))).toBeNull()
    ogd?.close()
    await mock?.close()
    const disabled = await provider(() => ({ message: {} }), { enabled: false })
    expect(await disabled.listFiles(listRequest())).toBeNull()
    expect(mock?.connections).toBe(0)
  })

  it('falls back while the worktree is still indexing', async () => {
    const search = await provider(() => ({ error: { code: 'not_indexed' } }))
    expect(await search.listFiles(listRequest())).toBeNull()
  })

  it('never asks the daemon about a root that is not a worktree root', async () => {
    const search = await provider(() => ({ message: {}, binary: Buffer.from('a') }))
    expect(await search.listFiles(listRequest({ rootPath: plainFolder }))).toBeNull()
    expect(mock?.requests).toEqual([])
  })

  it('remembers a root the daemon rejects as not a repository', async () => {
    mock = await startOgdMockServer({ handle: () => ({ error: { code: 'not_a_repo' } }) })
    ogd = new OgdClient({ socketPath: mock.socketPath, client: 'orca/test', timeoutMs: 500 })
    const client = ogd
    const search = createPodSearchProvider({ isEnabled: () => true, client: () => client })
    expect(await search.listFiles(listRequest())).toBeNull()
    expect(await search.listFiles(listRequest())).toBeNull()
    expect(mock.requests.map((request) => request.op)).toEqual(['register'])
  })

  it('falls back when no daemon listens on the socket', async () => {
    ogd = new OgdClient({ socketPath: join(repo, 'missing.sock'), client: 'orca/test' })
    const client = ogd
    const search = createPodSearchProvider({ isEnabled: () => true, client: () => client })
    expect(await search.listFiles(listRequest())).toBeNull()
  })

  it('turns an abort into the file-listing cancellation, not a fallback', async () => {
    const search = await provider(() => 'hang')
    const controller = new AbortController()
    const listing = search.listFiles(listRequest({ signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await expect(listing).rejects.toBeInstanceOf(FileListingCancelledError)
  })
})

describe('Pod search provider: ranked paths', () => {
  it('returns daemon order without blocklisted paths and reports a truncated page', async () => {
    const search = await provider(() => ({
      message: {
        results: [
          { path: 'src/TermPane.tsx', score: 213 },
          { path: 'node_modules/term/index.js', score: 200 },
          { path: 'src/terminal.ts', score: 180 },
          { path: 'src/term.css', score: 90 }
        ]
      }
    }))
    const result = await search.searchFilePaths({
      rootPath: repo,
      excludePathPrefixes: [],
      includeIgnored: false,
      followSymlinks: false,
      query: 'termpane',
      limit: 2
    })
    expect(result).toEqual({
      paths: ['src/TermPane.tsx', 'src/terminal.ts'],
      totalCount: 3,
      truncated: true
    })
    expect(mock?.requests.at(-1)).toMatchObject({ op: 'fuzzy', query: 'termpane', hidden: true })
  })

  it('only offers ranked search for ignored files when the daemon ranks them', async () => {
    const search = await provider(() => ({ message: { results: [] } }))
    const query = { rootPath: repo, includeIgnored: true, followSymlinks: false }
    expect(await search.supportsRankedPathSearch(query)).toBe(false)
    expect(await search.supportsRankedPathSearch({ ...query, includeIgnored: false })).toBe(true)
  })
})

describe('Pod search provider: text search', () => {
  const options = { query: 'useEffect', rootPath: '', caseSensitive: false, useRegex: false }
  const exact = [OGD_FEATURE_SEARCH_FULL_LINES, OGD_FEATURE_SEARCH_MAX_FILESIZE]
  const searchProvider = (handle: (request: OgdMessage) => OgdMockReply, features = exact) =>
    provider(handle, { features })
  const reply = (matches: unknown[]): OgdMockReply => ({ message: { matches, truncated: false } })

  it('maps byte ranges to UTF-16 columns and maps the case mode', async () => {
    const text = 'const ż = useEffect(() => {'
    const start = Buffer.byteLength('const ż = ')
    const search = await searchProvider(() =>
      reply([{ path: 'src/a.tsx', line: 12, col: start + 1, text, ranges: [[start, start + 9]] }])
    )
    const result = await search.searchText({ options, rootPath: repo, resultRootPath: repo })
    expect(result).toEqual({
      files: [
        {
          filePath: join(repo, 'src/a.tsx'),
          relativePath: 'src/a.tsx',
          matches: [{ line: 12, column: 11, matchLength: 9, lineContent: text }],
          matchCount: 1
        }
      ],
      totalMatches: 1,
      truncated: false
    })
    expect(mock?.requests.at(-1)).toMatchObject({
      op: 'search',
      pattern: 'useEffect',
      fixed: true,
      case: 'insensitive',
      hidden: true,
      max_filesize: 5 * 1024 * 1024,
      max_matches: 2000
    })
  })

  it('stays on ripgrep until the daemon matches with ripgrep semantics', async () => {
    for (const features of [
      [],
      [OGD_FEATURE_SEARCH_FULL_LINES],
      [OGD_FEATURE_SEARCH_MAX_FILESIZE]
    ]) {
      const search = await searchProvider(() => reply([]), features)
      expect(await search.searchText({ options, rootPath: repo, resultRootPath: repo })).toBeNull()
      expect(mock?.requests.some((request) => request.op === 'search')).toBe(false)
      await mock?.close()
      ogd?.close()
    }
  })

  it('keeps globs on ripgrep unless the daemon applies them as rg -g does', async () => {
    for (const globbed of [{ excludePattern: 'dist/**' }, { includePattern: '*.ts' }]) {
      const search = await searchProvider(() => reply([]))
      const request = { options: { ...options, ...globbed }, rootPath: repo, resultRootPath: repo }
      expect(await search.searchText(request)).toBeNull()
      await mock?.close()
      ogd?.close()
    }
    const negating = await searchProvider(
      () => reply([]),
      [...exact, OGD_FEATURE_SEARCH_NEGATED_GLOBS]
    )
    expect(
      await negating.searchText({
        options: { ...options, excludePattern: 'dist/**' },
        rootPath: repo,
        resultRootPath: repo
      })
    ).toEqual({ files: [], totalMatches: 0, truncated: false })
    expect(mock?.requests.at(-1)).toMatchObject({ globs: ['!dist/**'] })
  })

  it('serves long and non-UTF-8 lines as ripgrep does, and falls back on a clipped one', async () => {
    const long = `${'x'.repeat(20_000)} useEffect`
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from(' useEffect')])
    const search = await searchProvider(() =>
      reply([
        { path: 'long.json', line: 1, text: long, ranges: [[20_001, 20_010]] },
        { path: 'latin1.txt', line: 2, bytes: raw.toString('base64'), ranges: [[2, 11]] }
      ])
    )
    const result = await search.searchText({ options, rootPath: repo, resultRootPath: repo })
    expect(result?.totalMatches).toBe(2)
    expect(result?.files.map((file) => [file.relativePath, file.matches[0].column])).toEqual([
      ['long.json', 20_002],
      ['latin1.txt', 3]
    ])
    await mock?.close()
    ogd?.close()
    const clipped = await searchProvider(() =>
      reply([{ path: 'huge.js', line: 1, text: 'useEffect', clipped: true, ranges: [[0, 9]] }])
    )
    expect(await clipped.searchText({ options, rootPath: repo, resultRootPath: repo })).toBeNull()
  })

  it('marks the result truncated when a range lies outside its line', async () => {
    const search = await searchProvider(() =>
      reply([{ path: 'a.ts', line: 1, text: 'abc', ranges: [[5000, 5009]] }])
    )
    expect(await search.searchText({ options, rootPath: repo, resultRootPath: repo })).toEqual({
      files: [],
      totalMatches: 0,
      truncated: true
    })
  })
})

describe('Pod search provider: daemon-side exclusion', () => {
  const quickOpenGlobs = expect.arrayContaining(['!**/node_modules', '!nested/wt', '!nested/wt/**'])

  it('sends ripgrep quick-open globs to fuzzy and asks for one row past the page', async () => {
    const search = await provider(() => ({ message: { results: [{ path: 'src/a.ts' }] } }), {
      features: [OGD_FEATURE_FUZZY_EXCLUDE]
    })
    const result = await search.searchFilePaths({
      rootPath: repo,
      excludePathPrefixes: ['nested/wt'],
      includeIgnored: false,
      followSymlinks: false,
      query: 'a',
      limit: 10
    })
    expect(result).toEqual({ paths: ['src/a.ts'], totalCount: 1, truncated: false })
    expect(mock?.requests.at(-1)).toMatchObject({ op: 'fuzzy', limit: 11, globs: quickOpenGlobs })
  })

  it('sends the same globs to the listing', async () => {
    const search = await provider(() => ({ message: { count: 1 }, binary: Buffer.from('a.ts') }), {
      features: [OGD_FEATURE_FILES_EXCLUDE]
    })
    expect(await search.listFiles(listRequest({ excludePathPrefixes: ['nested/wt'] }))).toEqual([
      'a.ts'
    ])
    expect(mock?.requests.at(-1)).toMatchObject({ op: 'files', globs: quickOpenGlobs })
  })
})

describe('Pod search provider: editor activity', () => {
  const fuzzyRequest = () => ({
    rootPath: repo,
    excludePathPrefixes: [],
    includeIgnored: false,
    followSymlinks: false,
    query: 'term',
    limit: 5
  })

  it('touches opened and saved files and ranks quick open around the active file', async () => {
    const search = await provider((request) =>
      request.op === 'touch' ? { message: { accepted: 1 } } : { message: { results: [] } }
    )
    // Registers the root, so activity under it can name a current file.
    await search.searchFilePaths(fuzzyRequest())
    search.fileActivity?.({ filePath: join(repo, 'src', 'TermPane.tsx'), kind: 'open' })
    search.fileActivity?.({ filePath: join(repo, 'README.md'), kind: 'write' })
    await vi.waitFor(() =>
      expect(mock?.requests.filter((request) => request.op === 'touch')).toHaveLength(2)
    )
    expect(mock?.requests.filter((request) => request.op === 'touch')).toMatchObject([
      { paths: [join(repo, 'src', 'TermPane.tsx')], kind: 'open', agent: false },
      { paths: [join(repo, 'README.md')], kind: 'write', agent: false }
    ])
    await search.searchFilePaths(fuzzyRequest())
    expect(mock?.requests.at(-1)).toMatchObject({ op: 'fuzzy', current: 'src/TermPane.tsx' })
  })

  it('sends nothing while Pod search is off', async () => {
    const search = await provider(() => ({ message: {} }), { enabled: false })
    search.fileActivity?.({ filePath: join(repo, 'a.ts'), kind: 'open' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mock?.requests).toEqual([])
  })
})
