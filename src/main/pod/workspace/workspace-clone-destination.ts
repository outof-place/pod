import { join } from 'node:path'

/** Projects without a remote owner (local paths, `git init`, bare hosts) land here. */
export const POD_WORKSPACE_LOCAL_OWNER_DIR = '_local'

export type CloneOwnerAndName = {
  /** One segment for GitHub-style owners; several for GitLab subgroups and Azure org/project. */
  owner: string[]
  name: string
}

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i
// `user@host:path` or `host:path`; a drive letter (`C:\`) is a Windows path, not a host.
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/
const SAFE_SEGMENT = /^[^\0/\\]{1,255}$/

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..'
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function hostAndPath(url: string): { host: string; path: string } | null {
  if (SCHEME_URL.test(url)) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    return parsed.protocol === 'file:' ? null : { host: parsed.hostname, path: parsed.pathname }
  }
  const scp = SCP_LIKE.exec(url)
  if (!scp || /^[A-Za-z]$/.test(scp[1])) {
    return null
  }
  return { host: scp[1], path: scp[2] }
}

function providerSegments(host: string, segments: string[]): string[] {
  const lowerHost = host.toLowerCase()
  // Azure DevOps over SSH: `v3/<org>/<project>/<repo>`.
  if (
    (lowerHost === 'ssh.dev.azure.com' || lowerHost.endsWith('vs-ssh.visualstudio.com')) &&
    segments[0] === 'v3'
  ) {
    return segments.slice(1)
  }
  // Azure DevOps over HTTPS: `<org>/<project>/_git/<repo>`; legacy hosts carry the org in the host.
  const withoutGit = segments.filter((segment) => segment !== '_git')
  if (withoutGit.length !== segments.length && lowerHost.endsWith('.visualstudio.com')) {
    return [lowerHost.slice(0, -'.visualstudio.com'.length), ...withoutGit]
  }
  return withoutGit
}

/** Provider-neutral `<owner…>/<name>` from a clone URL; null when the URL names no owner. */
export function parseCloneOwnerAndName(url: string): CloneOwnerAndName | null {
  const location = hostAndPath(url.trim())
  if (!location) {
    return null
  }
  const rawSegments = location.path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  const segments: string[] = []
  for (const raw of rawSegments) {
    const decoded = decodeSegment(raw)
    if (decoded === null || !isSafeSegment(decoded)) {
      return null
    }
    segments.push(decoded)
  }
  const parts = providerSegments(location.host, segments)
  const name = parts.at(-1)
  return parts.length < 2 || name === undefined ? null : { owner: parts.slice(0, -1), name }
}

/**
 * Parent folder for Orca's clone dialog; Orca appends the repo folder itself, so the clone
 * lands in `<root>/<owner>/<repo>`.
 */
export function workspaceCloneParent(root: string, url: string): string {
  const parsed = parseCloneOwnerAndName(url)
  return parsed ? join(root, ...parsed.owner) : join(root, POD_WORKSPACE_LOCAL_OWNER_DIR)
}

export function workspaceCreateProjectParent(root: string): string {
  return join(root, POD_WORKSPACE_LOCAL_OWNER_DIR)
}
