// Fork-only (Pod): a Claude account profile's hooks once the default home's ride `--settings`
// (pod-claude-hook-service.ts). Profile setup runs on a worker without the app's bundle, so the
// runtime's launch templates decide. A profile's settings.json is Pod's own copy of the default
// home's: Pod's entries go from it only once the default home's are cut, since a claude started
// before the move may still read them (pod-claude-settings-cut.ts). No jsonc-parser here: its main
// build doesn't bundle into the worker. After agent-api's pod/claude-hooks-flag-settings 6859217697.
import { existsSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { readHooksJson, writeHooksJson } from '../../agent-hooks/installer-utils'
import { refuseProfileAtDefaultHome } from '../../claude/claude-profile-hook-target'
import { ClaudeHookService } from '../../claude/hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedScriptFileName,
  getStatusLineScriptFileName,
  removeManagedHooks,
  removeManagedStatusLine
} from '../../claude/hook-settings'
import {
  getPodClaudeLaunchSettingsPrefix,
  podClaudeLaunchTemplatesExist
} from './pod-claude-launch-settings'

export const POD_CLAUDE_SERVICE = { agent: 'claude', settings: CLAUDE_HOOK_SETTINGS } as const

/** Whether the default home's settings.json is past the cut: no Pod entry left (unreadable counts as
 *  not yet, the safe side). */
function defaultHomeCut(): boolean {
  const config = readHooksJson(getConfigPath(CLAUDE_HOOK_SETTINGS))
  if (!config) {
    return false
  }
  return (
    !removeManagedHooks(config, getManagedScriptFileName()).changed &&
    !removeManagedStatusLine(config, getStatusLineScriptFileName()).changed
  )
}

/** A profile with Pod's entries taken out once the default home's are; null before Pod's hooks come
 *  with each launch. */
export function installPodClaudeProfile(configDir: string): AgentHookInstallStatus | null {
  if (process.env.POD_CLAUDE_LAUNCH_SETTINGS === '0' || !podClaudeLaunchTemplatesExist()) {
    return null
  }
  const refused = refuseProfileAtDefaultHome(POD_CLAUDE_SERVICE, configDir)
  if (refused) {
    return refused
  }
  const configPath = getConfigPath(CLAUDE_HOOK_SETTINGS, configDir)
  const config = existsSync(configPath) ? readHooksJson(configPath) : {}
  if (!config) {
    return {
      agent: 'claude',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Claude settings.json'
    }
  }
  const hooks = removeManagedHooks(config, getManagedScriptFileName())
  const statusLine = removeManagedStatusLine(hooks.config, getStatusLineScriptFileName())
  if ((hooks.changed || statusLine.changed) && defaultHomeCut()) {
    writeHooksJson(configPath, statusLine.config, { preserveMode: true })
  }
  return {
    agent: 'claude',
    state: 'installed',
    configPath: `${getPodClaudeLaunchSettingsPrefix()}.command.json`,
    managedHooksPresent: true,
    detail: null
  }
}

export class PodClaudeProfileHookService extends ClaudeHookService {
  override install(
    options: { claudeVersion?: string; configDir?: string } = {}
  ): AgentHookInstallStatus {
    return (
      (options.configDir === undefined ? null : installPodClaudeProfile(options.configDir)) ??
      super.install(options)
    )
  }
}
