// Fork-only (Pod): Claude's statusLine through the native client (native/pod-agent-hook-macos)
// instead of two shells and curl on every refresh. A statusLine has no exec form (Claude 2.1.296
// drops its `args` and runs `/bin/sh -c`), so the command `exec`s the client: the shell becomes
// it, one process per refresh. The client runs as its own copy, pod-agent-statusline, so the
// agent tree's watcher knows it by its executable path alone (no argv read). A copy, not a
// hardlink: proc_pidpath of a file with two names may answer either.
import { basename } from 'node:path'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../../agent-hooks/hook-stdin-contract'
import { getSharedManagedScriptPath } from '../../agent-hooks/installer-utils'
import { getManagedCommand } from '../../claude/hook-settings'
import {
  getPodAgentHookInstallPath,
  installPodAgentHookBinary,
  POD_AGENT_HOOK_FILE_NAME,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'

export const POD_AGENT_STATUSLINE_FILE_NAME = 'pod-agent-statusline'

/** Beside the client, which it copies. */
export function getPodAgentStatusLineInstallPath(): string {
  return getSharedManagedScriptPath(POD_AGENT_STATUSLINE_FILE_NAME)
}

/** The statusline copy, else the client's subcommand (a copy not made yet), else the statusline
 *  script (Pod still writes it), else a silent drain. The script's path keeps the slot
 *  recognisably managed, by this Pod and by one before the client. */
export function podStatusLineCommand(scriptFileName: string): string {
  const statusLine = `"\${HOME-}/.pod/agent-hooks/${POD_AGENT_STATUSLINE_FILE_NAME}"`
  const client = `"\${HOME-}/.pod/agent-hooks/${POD_AGENT_HOOK_FILE_NAME}"`
  const script = `"\${HOME-}/.pod/agent-hooks/${scriptFileName}"`
  return [
    `if [ -x ${statusLine} ]; then exec ${statusLine}; fi`,
    `if [ -x ${client} ]; then exec ${client} statusline; fi`,
    `if [ -f ${script} ]; then exec /bin/sh ${script}; fi`,
    POSIX_HOOK_STDIN_DRAIN_COMMAND
  ].join('; ')
}

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
  if (native && bundled) {
    // Why no fallback here: while the copy is missing the command runs the client's subcommand.
    installPodAgentHookBinary(bundled, getPodAgentStatusLineInstallPath())
  }
  return native ? podStatusLineCommand(basename(scriptPath)) : getManagedCommand(scriptPath)
}
