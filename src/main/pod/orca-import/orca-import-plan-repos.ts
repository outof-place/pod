// Fork-only (Pod): which of Orca's projects and worktrees the import offers, and what each adds.
import { basename, isAbsolute } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { PodOrcaImportItem } from '../../../shared/pod-orca-import-types'
import type { Repo } from '../../../shared/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeId,
  WORKTREE_ID_SEPARATOR
} from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

/** A project's own preferences. Not hook scripts (they run commands), groups or remote hosts. */
const REPO_FIELDS = [
  'badgeColor',
  'worktreeBaseRef',
  'worktreeBasePath',
  'symlinkPaths',
  'issueSourcePreference',
  'forkSyncMode',
  'ghAccount',
  'externalWorktreeVisibility',
  'agentWorktreeVisibility',
  'importedExternalWorktreePaths'
] as const satisfies readonly (keyof Repo)[]

/** What a user wrote about a worktree. Not ownership, provenance, sessions or Orca-only ids. */
const WORKTREE_FIELDS = [
  'displayName',
  'comment',
  'linkedIssue',
  'linkedPR',
  'linkedGitLabMR',
  'linkedGitLabIssue',
  'linkedBitbucketPR',
  'linkedAzureDevOpsPR',
  'linkedGiteaPR',
  'linkedWorkItem',
  'linkedItems',
  'isArchived',
  'isPinned',
  'manualOrder',
  'createdAt',
  'baseRef',
  'preserveBranchOnDelete',
  'pushTarget',
  'diffComments'
] as const satisfies readonly (keyof WorktreeMeta)[]

export type RepoAction = {
  kind: 'repo'
  path: string
  repoKind: 'git' | 'folder'
  displayName: string
  fields: Partial<Repo>
}

export type WorktreeAction = {
  kind: 'worktree'
  repoItemId: string
  repoPath: string
  path: string
  isMain: boolean
  fields: Partial<WorktreeMeta>
}

export type PlannedRepoItem = {
  item: PodOrcaImportItem
  action: RepoAction | WorktreeAction | null
}

export type OrcaImportFsProbe = {
  isDirectory(path: string): boolean
  isGitCheckout(path: string): boolean
}

export function repoItemId(path: string): string {
  return `repo:${normalizeRuntimePathForComparison(path)}`
}

export function worktreeItemId(path: string): string {
  return `worktree:${normalizeRuntimePathForComparison(path)}`
}

function samePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  )
}

function isLocal(repo: Record<string, unknown>): boolean {
  const host = repo.executionHostId
  return !repo.connectionId && (host === undefined || host === null || host === 'local')
}

export function orcaRepos(value: unknown): Repo[] {
  return Array.isArray(value)
    ? value.filter(
        (repo): repo is Repo =>
          isRecord(repo) && typeof repo.id === 'string' && typeof repo.path === 'string'
      )
    : []
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<T> {
  const picked: Partial<T> = {}
  for (const key of keys) {
    if (!isEmpty(source[key])) {
      picked[key] = source[key]
    }
  }
  return picked
}

/** Orca's values for the fields Pod leaves empty; a pinned Orca name beats Pod's branch name. */
function fillWorktreeFields(
  orca: WorktreeMeta,
  pod: WorktreeMeta | undefined
): Partial<WorktreeMeta> {
  const fields: Partial<WorktreeMeta> = {}
  for (const key of WORKTREE_FIELDS) {
    if (isEmpty(orca[key]) || (pod && !isEmpty(pod[key]))) {
      continue
    }
    Object.assign(fields, { [key]: orca[key] })
  }
  if (orca.displayNameIsPinned && !pod?.displayNameIsPinned && orca.displayName) {
    fields.displayName = orca.displayName
    fields.displayNameIsPinned = true
  }
  return fields
}

function planRepo(repo: Repo, podRepo: Repo | undefined, fs: OrcaImportFsProbe): PlannedRepoItem {
  const kind = repo.kind === 'folder' ? 'folder' : 'git'
  const base = {
    id: repoItemId(repo.path),
    kind: 'repo' as const,
    title: repo.displayName || basename(repo.path),
    detail: repo.path
  }
  if (!isLocal(repo)) {
    return { item: { ...base, state: 'unsupported', selected: false }, action: null }
  }
  if (
    !isAbsolute(repo.path) ||
    !fs.isDirectory(repo.path) ||
    (kind === 'git' && !fs.isGitCheckout(repo.path))
  ) {
    return { item: { ...base, state: 'missing', selected: false }, action: null }
  }
  if (podRepo) {
    return { item: { ...base, state: 'present', selected: false }, action: null }
  }
  return {
    item: { ...base, state: 'new', selected: true },
    action: {
      kind: 'repo',
      path: repo.path,
      repoKind: kind,
      displayName: base.title,
      fields: pick(repo, REPO_FIELDS)
    }
  }
}

export function planRepos(input: {
  orcaRepos: Repo[]
  orcaWorktreeMeta: unknown
  podRepos: Repo[]
  podWorktreeMeta: Record<string, WorktreeMeta>
  fs: OrcaImportFsProbe
}): PlannedRepoItem[] {
  const planned: PlannedRepoItem[] = []
  const reposById = new Map<
    string,
    { repo: Repo; planned: PlannedRepoItem; pod: Repo | undefined }
  >()
  for (const repo of input.orcaRepos) {
    const pod = input.podRepos.find(
      (candidate) => isLocal(candidate) && samePath(candidate.path, repo.path)
    )
    const entry = { repo, planned: planRepo(repo, pod, input.fs), pod }
    reposById.set(repo.id, entry)
    planned.push(entry.planned)
  }
  const metaEntries = isRecord(input.orcaWorktreeMeta) ? Object.entries(input.orcaWorktreeMeta) : []
  for (const [worktreeId, rawMeta] of metaEntries) {
    const parsed = splitWorktreeId(worktreeId)
    const owner = parsed ? reposById.get(parsed.repoId) : undefined
    if (
      !parsed ||
      !owner ||
      !isRecord(rawMeta) ||
      !['new', 'present'].includes(owner.planned.item.state)
    ) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a record from Orca's own worktreeMeta domain; only WORKTREE_FIELDS are read, each checked by isEmpty.
    const meta = rawMeta as WorktreeMeta
    const path = parsed.worktreePath
    const base = {
      id: worktreeItemId(path),
      kind: 'worktree' as const,
      title: meta.displayName || basename(path),
      detail: path,
      parentId: owner.planned.item.id
    }
    if (path.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
      planned.push({ item: { ...base, state: 'unsupported', selected: false }, action: null })
      continue
    }
    if (!input.fs.isDirectory(path)) {
      planned.push({ item: { ...base, state: 'missing', selected: false }, action: null })
      continue
    }
    const isMain = samePath(path, owner.repo.path)
    const podMeta = owner.pod
      ? input.podWorktreeMeta[`${owner.pod.id}${WORKTREE_ID_SEPARATOR}${path}`]
      : undefined
    const fields = fillWorktreeFields(meta, podMeta)
    const shown =
      isMain ||
      (owner.pod?.importedExternalWorktreePaths ?? []).some((shownPath) =>
        samePath(shownPath, path)
      )
    if (Object.keys(fields).length === 0 && (shown || podMeta !== undefined)) {
      planned.push({ item: { ...base, state: 'present', selected: false }, action: null })
      continue
    }
    const state = podMeta ? 'update' : 'new'
    planned.push({
      item: { ...base, state, selected: true },
      action: {
        kind: 'worktree',
        repoItemId: owner.planned.item.id,
        repoPath: owner.repo.path,
        path,
        isMain,
        fields
      }
    })
  }
  return planned
}
