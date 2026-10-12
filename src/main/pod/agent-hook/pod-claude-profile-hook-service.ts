// Fork-only (Pod): a Claude account profile's hooks once the default home's ride `--settings`
// (pod-claude-hook-service.ts). Profile setup runs on a worker without the app's bundle, so the
// runtime's launch templates decide; a profile's settings.json is Pod's own copy, so Pod's entries
// simply go. No jsonc-parser here: its main build doesn't bundle into the worker. After agent-api's
// pod/claude-hooks-flag-settings 6859217697.
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

/** A profile with Pod's entries taken out; null while the default home keeps them in settings.json. */
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
  if (hooks.changed || statusLine.changed) {
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
