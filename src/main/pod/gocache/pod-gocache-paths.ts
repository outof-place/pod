import { join } from 'node:path'

/**
 * Where pod-gocache lives on an account. Terminals hold GOCACHEPROG across Pod updates and the
 * daemon host's relocation, so it names a copy under the home, never a path inside Pod.app.
 */
export const POD_GOCACHE_LABEL = 'codes.pod.gocache'

/** The helper inside the running app, which packaging puts at Contents/Resources/bin. */
export function podGoCacheBundledHelperPath(resourcesPath: string): string {
  return join(resourcesPath, 'bin', 'pod-gocache')
}

export function podGoCacheStateDir(home: string): string {
  return join(home, '.pod', 'gocache')
}

export function podGoCacheHelperPath(home: string): string {
  return join(podGoCacheStateDir(home), 'bin', 'pod-gocache')
}

export function podGoCacheDaemonLogPath(home: string): string {
  return join(podGoCacheStateDir(home), 'daemon.log')
}

export function podGoCacheLaunchAgentPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${POD_GOCACHE_LABEL}.plist`)
}
