// Fork-only (Pod): Claude's statusLine through the native client (`pod-agent-hook statusline`,
// native/pod-agent-hook-macos) instead of two shells and curl on every refresh. A statusLine has
// no exec form (Claude 2.1.296 drops its `args` and runs `/bin/sh -c`), so the command `exec`s
// the client: the shell becomes it, one process per refresh.
import { basename } from 'node:path'
import { getManagedCommand } from '../../claude/hook-settings'
import {
  getPodAgentHookInstallPath,
  installPodAgentHookBinary,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'
import { podStatusLineCommand } from './pod-claude-flag-settings'

export { podStatusLineCommand }

/** Claude's managed statusLine command: the client's once it is in place (copied beside the
 *  hooks), else the shell wrapper around the script. */
export function podManagedStatusLineCommand(
  service: { agent: string },
  scriptPath: string,
  bundled: string | null = resolveBundledPodAgentHook()
): string {
  const native =
    service.agent === 'claude' &&
    bundled !== null &&
    /^[A-Za-z0-9_.-]+$/.test(basename(scriptPath)) &&
    installPodAgentHookBinary(bundled, getPodAgentHookInstallPath())
  return native ? podStatusLineCommand(basename(scriptPath)) : getManagedCommand(scriptPath)
}
