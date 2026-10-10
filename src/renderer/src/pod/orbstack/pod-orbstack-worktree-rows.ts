import type {
  PodOrbstackContainer,
  PodOrbstackMachine,
  PodOrbstackStatus
} from '../../../../shared/pod-orbstack-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

type WorktreeLike = Pick<Worktree, 'id' | 'path' | 'displayName' | 'isBare'>

export type PodOrbstackWorktreeRow = {
  worktreeId: string
  displayName: string
  repoName: string
  path: string
  machine: PodOrbstackMachine | null
  dockerPinned: boolean
  sandbox: PodOrbstackMachine | null
  sandboxReady: boolean
  sandboxAgents: boolean
  sandboxAgentVersion: string | null
  containers: PodOrbstackContainer[]
  busy: boolean
}

function isLocalRepo(repo: Repo): boolean {
  return !repo.connectionId && (!repo.executionHostId || repo.executionHostId === 'local')
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** The deepest worktree containing the compose project wins, so a nested worktree keeps its own. */
function ownerOf(dir: string, paths: readonly string[]): string | null {
  let owner: string | null = null
  for (const path of paths) {
    if (isInside(dir, path) && (owner === null || path.length > owner.length)) {
      owner = path
    }
  }
  return owner
}

function findMachine(
  status: PodOrbstackStatus,
  name: string | null | undefined
): PodOrbstackMachine | null {
  return name ? (status.machines.find((machine) => machine.name === name) ?? null) : null
}

export function buildPodOrbstackWorktreeRows(
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly WorktreeLike[]>>,
  status: PodOrbstackStatus
): PodOrbstackWorktreeRow[] {
  const local = repos
    .filter(isLocalRepo)
    .flatMap((repo) =>
      (worktreesByRepo[repo.id] ?? [])
        .filter((worktree) => !worktree.isBare && worktree.path.startsWith('/'))
        .map((worktree) => ({ repo, worktree }))
    )
  const paths = local.map(({ worktree }) => worktree.path)
  const containersByPath = new Map<string, PodOrbstackContainer[]>()
  for (const container of status.containers) {
    const owner = container.composeWorkingDir ? ownerOf(container.composeWorkingDir, paths) : null
    if (owner) {
      containersByPath.set(owner, [...(containersByPath.get(owner) ?? []), container])
    }
  }
  return local.map(({ repo, worktree }) => {
    const link = status.links.find((entry) => entry.worktreeId === worktree.id)
    return {
      worktreeId: worktree.id,
      displayName: worktree.displayName,
      repoName: repo.displayName,
      path: worktree.path,
      machine: findMachine(status, link?.machine),
      dockerPinned: link?.dockerPinned === true,
      sandbox: findMachine(status, link?.sandbox),
      sandboxReady: link?.sandboxReady === true,
      sandboxAgents: link?.sandboxAgents === true,
      sandboxAgentVersion: link?.sandboxAgentVersion ?? null,
      containers: containersByPath.get(worktree.path) ?? [],
      busy: status.busyWorktreeIds.includes(worktree.id)
    }
  })
}
