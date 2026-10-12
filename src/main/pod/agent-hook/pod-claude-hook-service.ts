// Fork-only (Pod): Claude's hooks and statusLine come with each launch from Pod's launcher
// (pod-claude-launch-settings.ts) instead of ~/.claude/settings.json. Install writes the launch
// templates; Pod's older entries stay in settings.json for the claudes that started before (they
// stay silent for a launched claude: POD_CLAUDE_SETTINGS_PID) and go once none of those runs
// (pod-claude-settings-cut.ts). The hook registry takes this subclass; outside launch mode every
// call is ClaudeHookService's. After agent-api's pod/claude-hooks-flag-settings 6859217697.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { readHooksJson, writeManagedScript } from '../../agent-hooks/installer-utils'
import type { HookCommandConfig } from '../../agent-hooks/installer-utils'
import { claudeVersionReaches } from '../../claude/claude-hook-event-versions'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { ClaudeHookService, getManagedScript } from '../../claude/hook-service'
import {
  applyManagedHooks,
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedScriptFileName,
  getManagedScriptPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  hasSameManagedHookInvocation
} from '../../claude/hook-settings'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import {
  getPodAgentHookInstallPath,
  podAgentHookEntry,
  podManagedClaudeHook,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'
import { setPodClaudeAgentChangeListener } from './pod-claude-agent-change'
import { podManagedStatusLineCommand } from './pod-statusline-native'
import {
  CLAUDE_HTTP_HOOK_FIRST_VERSION,
  getPodClaudeLaunchSettingsPrefix,
  podClaudeLaunchSettingsEnabled,
  podClaudeLaunchStatusLineOn,
  podClaudeLaunchTemplatesExist,
  readPodClaudeLaunchHooks,
  removePodClaudeLaunchTemplates,
  resolvePodAgentLauncher,
  writePodClaudeLaunchTemplates,
  type PodClaudeStatusLine
} from './pod-claude-launch-settings'
import { installPodClaudeProfile, POD_CLAUDE_SERVICE } from './pod-claude-profile-hook-service'
import {
  launcherAwaitExit,
  PodClaudeSettingsCut,
  scanLegacyClaudes
} from './pod-claude-settings-cut'
import { readPodClaudeMigrations } from './pod-claude-settings-migration'

type Options = { claudeVersion?: string; configDir?: string }

/** Where the app ships its launcher, and kept once moved: the CLI's `agent-hooks install` has no
 *  bundle, and must not write Pod's hooks back. A Claude older than the one the launch settings were
 *  measured on keeps settings.json's entries; an unknown version keeps the last decision. */
export function podClaudeLaunchMode(claudeVersion?: string): boolean {
  if (process.platform !== 'darwin' || process.env.POD_CLAUDE_LAUNCH_SETTINGS === '0') {
    return false
  }
  const moved = podClaudeLaunchTemplatesExist()
  if (
    claudeVersion === undefined
      ? !moved
      : !claudeVersionReaches(claudeVersion, CLAUDE_HTTP_HOOK_FIRST_VERSION)
  ) {
    return false
  }
  return podClaudeLaunchSettingsEnabled() || moved
}

/** The launch templates' client entry: `--launch` tells it apart from settings.json's older one,
 *  which stays silent for a launched claude (pod-agent-hook.c), and keeps Claude from deduping the
 *  two into one. */
function launchHook(hook: HookCommandConfig): HookCommandConfig {
  return { ...hook, args: ['--launch'] }
}

let settingsCut: PodClaudeSettingsCut | null = null

/** One per process; the hook server's claude starts and exits recheck it. */
export function podClaudeSettingsCut(): PodClaudeSettingsCut {
  if (!settingsCut) {
    const launcher = resolvePodAgentLauncher()
    const cut = new PodClaudeSettingsCut({
      settingsPath: () => getConfigPath(CLAUDE_HOOK_SETTINGS),
      agentHooksDir: () => dirname(getPodClaudeLaunchSettingsPrefix()),
      names: () => ({
        hookScript: getManagedScriptFileName(),
        statusLineScript: getStatusLineScriptFileName()
      }),
      scan: () => scanLegacyClaudes(homedir()),
      // Why only in Electron's main process: the CLI exits right after its install.
      awaitExit:
        launcher && Reflect.get(process, 'type') === 'browser'
          ? (pids) => launcherAwaitExit(launcher, pids)
          : null,
      log: (event, details) => console.log(`[pod] ${event}`, JSON.stringify(details ?? {}))
    })
    setPodClaudeAgentChangeListener(() => cut.noteAgentChange())
    settingsCut = cut
  }
  return settingsCut
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
  const client = podManagedClaudeHook(POD_CLAUDE_SERVICE, scriptPath, { claudeVersion }, true)
  // Why: a host without the bundle (the CLI) can't install the client; the templates stay as written.
  if (client.command !== getPodAgentHookInstallPath()) {
    return
  }
  const hooks = applyManagedHooks({}, launchHook(client), getManagedScriptFileName(), plan)
  const statusLineOn =
    plan.statusLine === 'install' &&
    (first ? !statusLineOptedOut(settingsPath) : podClaudeLaunchStatusLineOn())
  let statusLine: PodClaudeStatusLine | null = null
  if (statusLineOn) {
    const statusLineScript = getStatusLineScriptPath()
    writeManagedScript(statusLineScript, getManagedStatusLineScript('local'))
    // Why the client's: it is in place (above), so a refresh is one process, as in settings.json.
    statusLine = {
      type: 'command',
      command: podManagedStatusLineCommand(POD_CLAUDE_SERVICE, statusLineScript)
    }
  }
  writePodClaudeLaunchTemplates(hooks, claudeVersion, statusLine)
}

export class PodClaudeHookService extends ClaudeHookService {
  constructor(private readonly cut: () => PodClaudeSettingsCut = podClaudeSettingsCut) {
    super()
  }

  override install(options: Options = {}): AgentHookInstallStatus {
    if (options.configDir !== undefined) {
      return installPodClaudeProfile(options.configDir) ?? super.install(options)
    }
    // Why the client: the launch templates' entries are the native client's (launchHook).
    const client = resolveBundledPodAgentHook() !== null || existsSync(getPodAgentHookInstallPath())
    if (!client || !podClaudeLaunchMode(options.claudeVersion)) {
      removePodClaudeLaunchTemplates()
      this.cut().disarm()
      return super.install(options)
    }
    const settingsPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
    try {
      // Why: an unknown version (one failed detection) keeps what the last known one wrote.
      if (options.claudeVersion !== undefined || !podClaudeLaunchTemplatesExist()) {
        writeLaunchTemplates(settingsPath, options.claudeVersion)
      }
      // Why after: the templates must be in place before settings.json loses Pod's entries.
      void this.cut().arm()
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
    const config = podClaudeLaunchMode(options.claudeVersion) ? readPodClaudeLaunchHooks() : null
    if (!config) {
      return super.getStatus(options)
    }
    // Why the entry itself: a host without the bundle (the CLI) still reads the templates as written.
    const expected = launchHook(podAgentHookEntry(getPodAgentHookInstallPath()))
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
    this.cut().disarm()
    return super.remove()
  }
}

export const podClaudeHookService = new PodClaudeHookService()
