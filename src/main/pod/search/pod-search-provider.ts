import { lstat, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { abortSignalReason } from '../../../shared/abort-signal-reason'
import { fileListingCancellationError } from '../../../shared/file-listing-cancellation'
import {
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../../../shared/quick-open-filter'
import type {
  ExternalFileActivity,
  ExternalFileListRequest,
  ExternalFilePathSearchRequest,
  ExternalRankedPathSearchQuery,
  ExternalTextSearchRequest,
  ExternalWorkspaceSearchProvider
} from '../../search/external-workspace-search-provider'
import type { OgdClient } from './ogd-client'
import { isOgdMessage, OgdRequestError, OgdUnavailableError, type OgdReply } from './ogd-connection'
import { collectQuickOpenListing, decodeOgdPathList } from './pod-search-listing'
import { buildOgdSearchRequest, ogdSearchReplyToResult } from './pod-search-text-results'

// Optional daemon capabilities, advertised in the hello `features` list. Without them the
// matching requests stay on ripgrep, because the results would not be the same.
export const OGD_FEATURE_FILES_IGNORED = 'files.ignored'
export const OGD_FEATURE_FUZZY_IGNORED = 'fuzzy.ignored'
export const OGD_FEATURE_FUZZY_EXCLUDE = 'fuzzy.exclude'
export const OGD_FEATURE_SEARCH_NEGATED_GLOBS = 'search.negated_globs'

// Over-fetch so client-side blocklist and nested-worktree filtering still fills the page.
const FUZZY_OVERFETCH = 4

type RootState = 'registered' | 'unsupported'

export type PodSearchProviderDeps = {
  isEnabled: () => boolean
  client: () => OgdClient | null
}

export function createPodSearchProvider(
  deps: PodSearchProviderDeps
): ExternalWorkspaceSearchProvider {
  const roots = new Map<string, RootState>()
  const registering = new Map<string, Promise<boolean>>()
  // The file last made active under each root; ogd ranks it below its peers in quick open.
  const currentFiles = new Map<string, string>()

  const activeClient = (): OgdClient | null => (deps.isEnabled() ? deps.client() : null)

  const registeredRootOf = (filePath: string): string | null => {
    let found: string | null = null
    for (const [root, state] of roots) {
      if (
        state === 'registered' &&
        filePath.startsWith(root + sep) &&
        (!found || root.length > found.length)
      ) {
        found = root
      }
    }
    return found
  }

  // Why the .git check: replies are relative to the worktree root, so a root inside a worktree
  // (or a plain folder workspace) would get paths for the wrong base.
  const isWorktreeRoot = async (root: string): Promise<boolean> => {
    try {
      await lstat(join(root, '.git'))
      return true
    } catch {
      return false
    }
  }

  const register = (client: OgdClient, root: string): Promise<boolean> => {
    const state = roots.get(root)
    if (state) {
      return Promise.resolve(state === 'registered')
    }
    const existing = registering.get(root)
    if (existing) {
      return existing
    }
    const attempt = (async () => {
      if (!(await isWorktreeRoot(root))) {
        roots.set(root, 'unsupported')
        return false
      }
      try {
        // Why no wait: the daemon builds in the background and its first queries answer
        // not_indexed, which falls back to ripgrep instead of making quick open wait.
        const reply = await client.request('register', { root, wait: false })
        const worktree = reply.message.worktree
        if (typeof worktree === 'string' && worktree !== (await realpath(root))) {
          roots.set(root, 'unsupported')
          return false
        }
        roots.set(root, 'registered')
        return true
      } catch (error) {
        if (
          error instanceof OgdRequestError &&
          (error.code === 'not_a_repo' || error.code === 'outside' || error.code === 'bad_request')
        ) {
          roots.set(root, 'unsupported')
        }
        return false
      } finally {
        registering.delete(root)
      }
    })()
    registering.set(root, attempt)
    return attempt
  }

  const query = async (
    client: OgdClient,
    root: string,
    op: string,
    fields: Record<string, unknown>,
    signal: AbortSignal | undefined,
    cancellation: () => Error
  ): Promise<OgdReply | null> => {
    try {
      return await client.request(op, { ...fields, root }, { signal })
    } catch (error) {
      if (signal?.aborted) {
        throw cancellation()
      }
      if (
        error instanceof OgdRequestError &&
        (error.code === 'not_a_repo' || error.code === 'outside')
      ) {
        roots.set(root, 'unsupported')
      }
      if (error instanceof OgdUnavailableError) {
        // A restarted daemon has forgotten its registrations.
        roots.delete(root)
      }
      return null
    }
  }

  return {
    async listFiles(request: ExternalFileListRequest): Promise<string[] | null> {
      const client = activeClient()
      if (
        !client ||
        request.followSymlinks ||
        // Recent-file validation must see ignored files too, and is small enough for ripgrep.
        request.candidatePaths !== undefined ||
        // Registering first also handshakes, so the feature list below is known.
        !(await register(client, request.rootPath)) ||
        (request.includeIgnored && !client.hasFeature(OGD_FEATURE_FILES_IGNORED))
      ) {
        return null
      }
      const cancellation = (): Error => fileListingCancellationError(request.signal)
      const reply = await query(
        client,
        request.rootPath,
        'files',
        { hidden: true, barrier: true, ...(request.includeIgnored ? { ignored: true } : {}) },
        request.signal,
        cancellation
      )
      if (!reply) {
        return null
      }
      if (request.signal?.aborted) {
        throw cancellation()
      }
      return collectQuickOpenListing(decodeOgdPathList(reply.binary), request)
    },

    async searchFilePaths(request: ExternalFilePathSearchRequest) {
      const client = activeClient()
      if (
        !client ||
        request.followSymlinks ||
        !(await register(client, request.rootPath)) ||
        (request.includeIgnored && !client.hasFeature(OGD_FEATURE_FUZZY_IGNORED))
      ) {
        return null
      }
      const reply = await query(
        client,
        request.rootPath,
        'fuzzy',
        {
          query: request.query,
          limit: request.limit * FUZZY_OVERFETCH,
          hidden: true,
          ...(currentFiles.has(request.rootPath)
            ? { current: currentFiles.get(request.rootPath) }
            : {}),
          ...(request.includeIgnored ? { ignored: true } : {}),
          ...(client.hasFeature(OGD_FEATURE_FUZZY_EXCLUDE)
            ? { exclude: request.excludePathPrefixes }
            : {})
        },
        request.signal,
        () => fileListingCancellationError(request.signal)
      )
      const results = reply?.message.results
      if (!reply || !Array.isArray(results)) {
        return null
      }
      const paths: string[] = []
      let matched = 0
      for (const result of results) {
        const path = isOgdMessage(result) ? result.path : undefined
        if (
          typeof path !== 'string' ||
          !shouldIncludeQuickOpenPath(path) ||
          shouldExcludeQuickOpenRelPath(path, request.excludePathPrefixes)
        ) {
          continue
        }
        matched++
        if (paths.length < request.limit) {
          paths.push(path)
        }
      }
      const truncated = matched > request.limit || results.length >= request.limit * FUZZY_OVERFETCH
      return {
        paths,
        totalCount: truncated ? Math.max(matched, request.limit + 1) : matched,
        truncated
      }
    },

    async searchText(request: ExternalTextSearchRequest) {
      const client = activeClient()
      if (!client || !(await register(client, request.rootPath))) {
        return null
      }
      const { fields, hasNegatedGlobs } = buildOgdSearchRequest(request.options, request.rootPath)
      if (hasNegatedGlobs && !client.hasFeature(OGD_FEATURE_SEARCH_NEGATED_GLOBS)) {
        return null
      }
      const reply = await query(client, request.rootPath, 'search', fields, request.signal, () =>
        request.signal ? abortSignalReason(request.signal) : new Error('search aborted')
      )
      if (!reply) {
        return null
      }
      return ogdSearchReplyToResult(reply.message, request.resultRootPath, request.options)
    },

    async supportsRankedPathSearch(request: ExternalRankedPathSearchQuery): Promise<boolean> {
      const client = activeClient()
      if (!client || request.followSymlinks || !(await register(client, request.rootPath))) {
        return false
      }
      return !request.includeIgnored || client.hasFeature(OGD_FEATURE_FUZZY_IGNORED)
    },

    worktreeAdded(worktreePath: string): void {
      const client = activeClient()
      if (client) {
        void register(client, worktreePath)
      }
    },

    worktreeRemoved(worktreePath: string): void {
      roots.delete(worktreePath)
      currentFiles.delete(worktreePath)
      const client = activeClient()
      if (client) {
        void client.request('forget', { root: worktreePath }).catch(() => undefined)
      }
    },

    fileActivity({ filePath, kind }: ExternalFileActivity): void {
      const client = activeClient()
      if (!client) {
        return
      }
      const root = registeredRootOf(filePath)
      if (kind === 'open' && root) {
        currentFiles.set(root, relative(root, filePath).split(sep).join('/'))
      }
      // Opens feed ogd's frecency; writes mark the file changed before its file events land.
      void client.request('touch', { paths: [filePath], kind, agent: false }).catch(() => undefined)
    }
  }
}
