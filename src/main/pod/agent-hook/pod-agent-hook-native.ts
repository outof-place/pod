// Fork-only (Pod): Claude's managed status hook as one native process (native/pod-agent-hook-macos),
// run in exec form, instead of `sh -c` + claude-hook.sh (~45 ms CPU per event). Same posts and spool.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  type HookCommandConfig
} from '../../agent-hooks/installer-utils'
import { claudeVersionReaches } from '../../claude/claude-hook-event-versions'
import {
  getManagedLifecycleHook,
  type ClaudeCompatibleHookSettings
} from '../../claude/hook-settings'
import { bakedPodUserData } from '../decouple/legacy-hook-env'

export const POD_AGENT_HOOK_FILE_NAME = 'pod-agent-hook'
/** Claude's exec form (`args`) on command hooks, from its changelog. */
export const CLAUDE_EXEC_FORM_HOOK_FIRST_VERSION = '2.1.139'

type BundleOptions = {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  resourcesPath?: string | undefined
}

/** The client this app ships (Contents/Resources/bin), or POD_AGENT_HOOK_BINARY's in a checkout. */
export function resolveBundledPodAgentHook(options: BundleOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'darwin') {
    return null
  }
  const env = options.env ?? process.env
  // Electron's; the CLI links this file too, where process has no resourcesPath.
  const appResources: unknown = Reflect.get(process, 'resourcesPath')
  const resourcesPath =
    'resourcesPath' in options
      ? options.resourcesPath
      : typeof appResources === 'string'
        ? appResources
        : undefined
  const candidates = [
    env.POD_AGENT_HOOK_BINARY,
    resourcesPath ? join(resourcesPath, 'bin', POD_AGENT_HOOK_FILE_NAME) : undefined
  ]
  return (
    candidates.find(
      (path): path is string => typeof path === 'string' && path !== '' && existsSync(path)
    ) ?? null
  )
}

/** Where settings.json points at the client: beside claude-hook.sh, so app moves and updates keep it. */
export function getPodAgentHookInstallPath(): string {
  return getSharedManagedScriptPath(POD_AGENT_HOOK_FILE_NAME)
}

export function podAgentHookEntry(installPath: string): HookCommandConfig {
  return { type: 'command', command: installPath, args: [], timeout: MANAGED_HOOK_TIMEOUT_SECONDS }
}

/** Writes `path` when its bytes differ; temp + rename, since an in-place overwrite gets the
 *  binary's next launches SIGKILLed on macOS. */
function replaceWhenChanged(path: string, content: Buffer, mode: number): void {
  if (existsSync(path) && readFileSync(path).equals(content)) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, content, { mode })
    chmodSync(temp, mode)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Beside the client: the data folder of the Pod that installed it, the only one an ORCA_
 *  endpoint from a terminal before the decouple may lie in. Without it the client takes no ORCA_
 *  name (pod-decouple). TODO(pod): drop with that fallback, after 2026-12-31. */
export const POD_AGENT_HOOK_USER_DATA_SUFFIX = '.user-data'

function recordPodAgentHookUserData(installPath: string): void {
  const path = `${installPath}${POD_AGENT_HOOK_USER_DATA_SUFFIX}`
  try {
    const userData = bakedPodUserData()
    if (userData === null) {
      rmSync(path, { force: true })
    } else {
      replaceWhenChanged(path, Buffer.from(`${userData}\n`), 0o644)
    }
  } catch (error) {
    console.warn('[agent-hooks] pod-agent-hook data folder not recorded:', error)
  }
}

/** Copies the client when its bytes differ. */
export function installPodAgentHookBinary(bundled: string, installPath: string): boolean {
  try {
    replaceWhenChanged(installPath, readFileSync(bundled), 0o755)
  } catch (error) {
    console.warn('[agent-hooks] pod-agent-hook not installed, keeping claude-hook.sh:', error)
    return false
  }
  recordPodAgentHookUserData(installPath)
  return true
}

/** Claude's managed entry: the native client once it's in place (copied on install), else the
 *  shell entry. A status check carries no version, so an installed client decides there. */
export function podManagedClaudeHook(
  service: { agent: string; settings: ClaudeCompatibleHookSettings },
  scriptPath: string,
  options: { claudeVersion?: string },
  install: boolean,
  bundled: string | null = resolveBundledPodAgentHook()
): HookCommandConfig {
  const fallback = getManagedLifecycleHook(scriptPath, service.settings)
  if (service.agent !== 'claude' || !bundled) {
    return fallback
  }
  const installPath = getPodAgentHookInstallPath()
  if (!install && options.claudeVersion === undefined) {
    return existsSync(installPath) ? podAgentHookEntry(installPath) : fallback
  }
  if (!claudeVersionReaches(options.claudeVersion, CLAUDE_EXEC_FORM_HOOK_FIRST_VERSION)) {
    return fallback
  }
  if (install) {
    return installPodAgentHookBinary(bundled, installPath)
      ? podAgentHookEntry(installPath)
      : fallback
  }
  return existsSync(installPath) ? podAgentHookEntry(installPath) : fallback
}
