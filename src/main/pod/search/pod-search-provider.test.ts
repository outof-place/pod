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
  OGD_FEATURE_FILES_IGNORED,
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

  it('maps byte ranges to UTF-16 columns and maps the case mode', async () => {
    const text = 'const ż = useEffect(() => {'
    const start = Buffer.byteLength('const ż = ')
    const search = await provider(() => ({
      message: {
        matches: [
          { path: 'src/a.tsx', line: 12, col: start + 1, text, ranges: [[start, start + 9]] }
        ],
        truncated: false
      }
    }))
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
      max_filesize: 5 * 1024 * 1024
    })
  })

  it('keeps exclude globs on ripgrep unless the daemon supports negated globs', async () => {
    const reply = (): OgdMockReply => ({ message: { matches: [], truncated: false } })
    const search = await provider(reply)
    const excluding = { ...options, excludePattern: 'dist/**' }
    expect(
      await search.searchText({ options: excluding, rootPath: repo, resultRootPath: repo })
    ).toBeNull()
    await mock?.close()
    ogd?.close()
    const negating = await provider(reply, { features: [OGD_FEATURE_SEARCH_NEGATED_GLOBS] })
    expect(
      await negating.searchText({ options: excluding, rootPath: repo, resultRootPath: repo })
    ).toEqual({ files: [], totalMatches: 0, truncated: false })
    expect(mock?.requests.at(-1)).toMatchObject({ globs: ['!dist/**'] })
  })

  it('falls back to ripgrep when ogd clipped or lossily decoded a matched line', async () => {
    const long = `${'x'.repeat(1990)} useEffect`
    for (const text of [long, 'useEffect \uFFFD']) {
      const search = await provider(() => ({
        message: { matches: [{ path: 'a.ts', line: 1, text, ranges: [[0, 9]] }], truncated: false }
      }))
      expect(await search.searchText({ options, rootPath: repo, resultRootPath: repo })).toBeNull()
      await mock?.close()
      ogd?.close()
    }
  })

  it('marks the result truncated when a range lies outside its line', async () => {
    const search = await provider(() => ({
      message: { matches: [{ path: 'a.ts', line: 1, text: 'abc', ranges: [[5000, 5009]] }] }
    }))
    expect(await search.searchText({ options, rootPath: repo, resultRootPath: repo })).toEqual({
      files: [],
      totalMatches: 0,
      truncated: true
    })
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
