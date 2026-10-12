// Fork-only (Pod): Claude's statusLine through the native client (`pod-agent-hook statusline`,
// native/pod-agent-hook-macos) instead of two shells and curl on every refresh. A statusLine has
// no exec form (Claude 2.1.296 drops its `args` and runs `/bin/sh -c`), so the command `exec`s
// the client: the shell becomes it, one process per refresh.
import { basename } from 'node:path'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../../agent-hooks/hook-stdin-contract'
import { getManagedCommand } from '../../claude/hook-settings'
import {
  getPodAgentHookInstallPath,
  installPodAgentHookBinary,
  POD_AGENT_HOOK_FILE_NAME,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'

/** The client, else the statusline script (Pod still writes it), else a silent drain. The
 *  script's path keeps the slot recognisably managed, by this Pod and by one before the client. */
export function podStatusLineCommand(scriptFileName: string): string {
  const client = `"\${HOME-}/.orca/agent-hooks/${POD_AGENT_HOOK_FILE_NAME}"`
  const script = `"\${HOME-}/.orca/agent-hooks/${scriptFileName}"`
  return [
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
  return native ? podStatusLineCommand(basename(scriptPath)) : getManagedCommand(scriptPath)
}
