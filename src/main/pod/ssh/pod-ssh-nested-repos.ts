// Fork-only (Pod): the nested repo scan and import on an SSH host (projectGroups:scanNested and
// projectGroups:importNested with a connection) for runtime RPC, installed by the IPC layer so the
// runtime's module graph stays free of Electron (config/runtime-electron-baseline.txt).
import type {
  NestedRepoScanResult,
  ProjectGroupImportMode,
  ProjectGroupImportResult
} from '../../../shared/project-group-types'

export type PodSshNestedImportArgs = {
  connectionId: string
  parentPath: string
  groupName: string
  projectPaths: string[]
  mode: ProjectGroupImportMode
}

export type PodSshNestedRepos = {
  /** Refuses a connection that isn't connected before it reads anything on the host. */
  scan: (connectionId: string, path: string) => Promise<NestedRepoScanResult>
  import: (args: PodSshNestedImportArgs) => Promise<ProjectGroupImportResult>
}

let installed: PodSshNestedRepos | null = null

export function setPodSshNestedRepos(ops: PodSshNestedRepos | null): void {
  installed = ops
}

/** Null on a host whose SSH layer never registered (orcad). */
export function getPodSshNestedRepos(): PodSshNestedRepos | null {
  return installed
}

/** A folder on the host as the runtime takes it: POSIX absolute, no `..` segment, no NUL. */
export function assertPodSshNestedPath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    throw new Error('Project path must be an absolute path on the SSH host')
  }
}

function ops(): PodSshNestedRepos {
  const current = getPodSshNestedRepos()
  if (!current) {
    throw new Error('runtime_unavailable')
  }
  return current
}

/** The paths are checked before the host is asked anything. */
export async function scanPodSshNestedRepos(
  connectionId: string,
  path: string
): Promise<NestedRepoScanResult> {
  assertPodSshNestedPath(path)
  return ops().scan(connectionId, path)
}

export async function importPodSshNestedRepos(
  args: PodSshNestedImportArgs
): Promise<ProjectGroupImportResult> {
  assertPodSshNestedPath(args.parentPath)
  for (const path of args.projectPaths) {
    assertPodSshNestedPath(path)
  }
  return ops().import(args)
}
