// Fork-only (Pod): Claude's hooks and statusLine come with each launch from Pod's launcher
// (pod-claude-launch-settings.ts) instead of ~/.claude/settings.json. Install writes the launch
// templates first, then takes Pod's entries out of settings.json once, byte for byte around the
// user's (pod-claude-settings-migration.ts). The hook registry takes this subclass; outside launch
// mode every call is ClaudeHookService's. After agent-api's pod/claude-hooks-flag-settings 6859217697.
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { readHooksJson, writeManagedScript } from '../../agent-hooks/installer-utils'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { ClaudeHookService, getManagedScript } from '../../claude/hook-service'
import {
  applyManagedHooks,
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedCommand,
  getManagedScriptFileName,
  getManagedScriptPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  hasSameManagedHookInvocation
} from '../../claude/hook-settings'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import { podManagedClaudeHook } from './pod-agent-hook-native'
import {
  getPodClaudeLaunchSettingsPrefix,
  podClaudeLaunchSettingsEnabled,
  podClaudeLaunchStatusLineOn,
  podClaudeLaunchTemplatesExist,
  readPodClaudeLaunchHooks,
  removePodClaudeLaunchTemplates,
  writePodClaudeLaunchTemplates,
  type PodClaudeStatusLine
} from './pod-claude-launch-settings'
import { installPodClaudeProfile, POD_CLAUDE_SERVICE } from './pod-claude-profile-hook-service'
import { migratePodClaudeSettings, readPodClaudeMigrations } from './pod-claude-settings-migration'

type Options = { claudeVersion?: string; configDir?: string }

/** Where the app ships its launcher, and kept once moved: the CLI's `agent-hooks install` has no
 *  bundle, and must not write Pod's hooks back. */
export function podClaudeLaunchMode(): boolean {
  if (process.platform !== 'darwin' || process.env.POD_CLAUDE_LAUNCH_SETTINGS === '0') {
    return false
  }
  return podClaudeLaunchSettingsEnabled() || podClaudeLaunchTemplatesExist()
}

/** A user who deleted Pod's statusLine before the move keeps it off (hook-service's marker rule). */
function statusLineOptedOut(settingsPath: string): boolean {
  const config = readHooksJson(settingsPath)
  return (
    config !== null &&
    getStatusLineSlotState(config, getStatusLineScriptFileName()) === 'empty' &&
    existsSync(getStatusLineInstallMarkerPath())
  )
}

function writeLaunchTemplates(settingsPath: string, claudeVersion: string | undefined): void {
  const first =
    !podClaudeLaunchTemplatesExist() &&
    readPodClaudeMigrations(dirname(getPodClaudeLaunchSettingsPrefix())).length === 0
  const plan = getClaudeManagedHookPlan(claudeVersion)
  const scriptPath = getManagedScriptPath()
  writeManagedScript(
    scriptPath,
    getManagedScript('local', { skipWhenDevinImportsClaude: true, skipWhenGrokImportsClaude: true })
  )
  const hook = podManagedClaudeHook(POD_CLAUDE_SERVICE, scriptPath, { claudeVersion }, true)
  const hooks = applyManagedHooks({}, hook, getManagedScriptFileName(), plan)
  const statusLineOn =
    plan.statusLine === 'install' &&
    (first ? !statusLineOptedOut(settingsPath) : podClaudeLaunchStatusLineOn())
  let statusLine: PodClaudeStatusLine | null = null
  if (statusLineOn) {
    const statusLineScript = getStatusLineScriptPath()
    writeManagedScript(statusLineScript, getManagedStatusLineScript('local'))
    statusLine = { type: 'command', command: getManagedCommand(statusLineScript) }
  }
  writePodClaudeLaunchTemplates(hooks, claudeVersion, statusLine)
}

export class PodClaudeHookService extends ClaudeHookService {
  override install(options: Options = {}): AgentHookInstallStatus {
    if (options.configDir !== undefined) {
      return installPodClaudeProfile(options.configDir) ?? super.install(options)
    }
    if (!podClaudeLaunchMode()) {
      removePodClaudeLaunchTemplates()
      return super.install(options)
    }
    const settingsPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
    try {
      // Why: an unknown version (one failed detection) keeps what the last known one wrote.
      if (options.claudeVersion !== undefined || !podClaudeLaunchTemplatesExist()) {
        writeLaunchTemplates(settingsPath, options.claudeVersion)
      }
      // Why after: the templates must be in place before settings.json loses Pod's entries.
      migratePodClaudeSettings(settingsPath, dirname(getPodClaudeLaunchSettingsPrefix()), {
        hookScript: getManagedScriptFileName(),
        statusLineScript: getStatusLineScriptFileName()
      })
    } catch (error) {
      return {
        agent: 'claude',
        state: 'error',
        configPath: settingsPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    return this.getStatus(options)
  }

  override getStatus(options: Options = {}): AgentHookInstallStatus {
    const config = podClaudeLaunchMode() ? readPodClaudeLaunchHooks() : null
    if (!config) {
      return super.getStatus(options)
    }
    const expected = podManagedClaudeHook(
      POD_CLAUDE_SERVICE,
      getManagedScriptPath(),
      options,
      false
    )
    const events = getClaudeManagedHookPlan(options.claudeVersion).install
    const missing = events
      .map((event) => event.eventName)
      .filter(
        (name) =>
          !(config.hooks?.[name] ?? []).some((definition) =>
            (definition.hooks ?? []).some((hook) => hasSameManagedHookInvocation(hook, expected))
          )
      )
    return {
      agent: 'claude',
      state:
        missing.length === 0
          ? 'installed'
          : missing.length < events.length
            ? 'partial'
            : 'not_installed',
      configPath: `${getPodClaudeLaunchSettingsPrefix()}.command.json`,
      managedHooksPresent: missing.length < events.length,
      detail: missing.length === 0 ? null : `Managed hook missing for events: ${missing.join(', ')}`
    }
  }

  override remove(): AgentHookInstallStatus {
    removePodClaudeLaunchTemplates()
    return super.remove()
  }
}

export const podClaudeHookService = new PodClaudeHookService()
