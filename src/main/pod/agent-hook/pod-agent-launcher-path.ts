// Fork-only (Pod): where pod-agent-launcher is, for the pane PATH and the daemon's start.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const POD_AGENT_LAUNCHER_FILE_NAME = 'pod-agent-launcher'

/** POD_AGENT_LAUNCHER_BINARY's (a checkout's launcher), else the app's `<resourcesPath>/bin`; the
 *  first that exists. */
export function findPodAgentLauncher(
  resourcesPath: string | null | undefined,
  overridePath: string | undefined
): string | null {
  return (
    [
      overridePath,
      resourcesPath ? join(resourcesPath, 'bin', POD_AGENT_LAUNCHER_FILE_NAME) : undefined
    ].find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path)) ??
    null
  )
}
