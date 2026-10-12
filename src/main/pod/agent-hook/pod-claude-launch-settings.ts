// Fork-only (Pod): Claude's agent-status hooks come with each launch in a Pod pane, not from
// ~/.claude/settings.json. Pod's launcher (product/agent-launcher/main.swift, `claude` first on every
// pane's PATH) passes `--settings` from two templates written here: http hooks to the terminal
// daemon's relay (no process per event; the relay answers at once), or Pod's command hook client
// where the relay is missing. settings.json keeps none of Pod's hooks, so nothing rewrites it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  type HookCommandConfig,
  type HooksConfig
} from '../../agent-hooks/installer-utils'
import { claudeVersionReaches } from '../../claude/claude-hook-event-versions'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import {
  applyManagedHooks,
  getManagedScriptFileName,
  removeManagedHooks,
  type ClaudeCompatibleHookSettings
} from '../../claude/hook-settings'
import { podManagedClaudeHook } from './pod-agent-hook-native'

/** PTY env: the templates' prefix (`<prefix>.http.json`, `<prefix>.command.json`). */
export const POD_CLAUDE_LAUNCH_SETTINGS_ENV = 'POD_CLAUDE_LAUNCH_SETTINGS'
/** Claude's http hooks, from its changelog. */
export const CLAUDE_HTTP_HOOK_FIRST_VERSION = '2.1.63'
const LAUNCHER_FILE_NAME = 'pod-agent-launcher'
const PREFIX_NAME = 'pod-claude-settings'

type LaunchOptions = {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  resourcesPath?: string | undefined
}

/** On where the app ships its launcher (Contents/Resources/bin), or POD_AGENT_LAUNCHER_BINARY's
 *  in a checkout whose panes have it first on PATH. POD_CLAUDE_LAUNCH_SETTINGS=0 switches it off. */
export function podClaudeLaunchSettingsEnabled(options: LaunchOptions = {}): boolean {
  const env = options.env ?? process.env
  if (
    (options.platform ?? process.platform) !== 'darwin' ||
    env[POD_CLAUDE_LAUNCH_SETTINGS_ENV] === '0'
  ) {
    return false
  }
  const appResources: unknown = Reflect.get(process, 'resourcesPath')
  const resourcesPath =
    'resourcesPath' in options
      ? options.resourcesPath
      : typeof appResources === 'string'
        ? appResources
        : undefined
  return [
    env.POD_AGENT_LAUNCHER_BINARY,
    resourcesPath ? join(resourcesPath, 'bin', LAUNCHER_FILE_NAME) : undefined
  ].some((path) => typeof path === 'string' && path !== '' && existsSync(path))
}

export function getPodClaudeLaunchSettingsPrefix(): string {
  return getSharedManagedScriptPath(PREFIX_NAME)
}

/** The command hooks, with an http hook for every event but SessionStart (Claude fires no http
 *  hook for it): the relay's address and the pane come from the launcher. */
function httpVariant(command: HooksConfig): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {}
  for (const [event, definitions] of Object.entries(command.hooks ?? {})) {
    hooks[event] =
      event === 'SessionStart'
        ? definitions
        : definitions.map((definition) => ({
            ...definition,
            hooks: (definition.hooks ?? []).map((hook) => ({
              type: 'http',
              url: '@@POD_RELAY_URL@@',
              timeout: hook.timeout ?? MANAGED_HOOK_TIMEOUT_SECONDS,
              headers: {
                'X-Pod-Hook-Relay-Token': '@@POD_RELAY_TOKEN@@',
                'X-Pod-Hook-Relay-Pane': '@@POD_RELAY_PANE@@',
                'X-Orca-Agent-Process': '@@POD_AGENT_PROCESS@@'
              }
            }))
          }))
  }
  return { hooks }
}

/** Temp + rename; untouched when the bytes are the same. */
function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o644 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function writePodClaudeLaunchTemplates(
  command: HooksConfig,
  claudeVersion: string | undefined,
  prefix: string = getPodClaudeLaunchSettingsPrefix()
): void {
  const http = claudeVersionReaches(claudeVersion, CLAUDE_HTTP_HOOK_FIRST_VERSION)
    ? httpVariant(command)
    : { hooks: command.hooks }
  writeIfChanged(`${prefix}.command.json`, `${JSON.stringify({ hooks: command.hooks }, null, 2)}\n`)
  writeIfChanged(`${prefix}.http.json`, `${JSON.stringify(http, null, 2)}\n`)
}

export function removePodClaudeLaunchTemplates(prefix = getPodClaudeLaunchSettingsPrefix()): void {
  for (const suffix of ['.command.json', '.http.json']) {
    rmSync(`${prefix}${suffix}`, { force: true })
  }
}

/** PTY env for the launcher; none until the templates are written. */
export function podClaudeLaunchSettingsEnv(): Record<string, string> {
  const prefix = getPodClaudeLaunchSettingsPrefix()
  return podClaudeLaunchSettingsEnabled() && existsSync(`${prefix}.command.json`)
    ? { [POD_CLAUDE_LAUNCH_SETTINGS_ENV]: prefix }
    : {}
}

type HookService = { agent: string; settings: ClaudeCompatibleHookSettings }

/** Install: Pod's hooks go to the launch templates, and settings.json loses any it had (one write,
 *  then none). Elsewhere, or for another agent, they go to settings.json as before. */
export function applyClaudeHooks(
  service: HookService,
  config: HooksConfig,
  hook: HookCommandConfig,
  plan: Parameters<typeof applyManagedHooks>[3],
  options: { claudeVersion?: string },
  enabled: boolean = podClaudeLaunchSettingsEnabled()
): HooksConfig {
  const scriptFileName = getManagedScriptFileName(service.settings)
  if (service.agent !== 'claude' || !enabled) {
    return applyManagedHooks(config, hook, scriptFileName, plan)
  }
  writePodClaudeLaunchTemplates(
    applyManagedHooks({}, hook, scriptFileName, plan),
    options.claudeVersion
  )
  return removeManagedHooks(config, scriptFileName).config
}

/** Status: settings.json as read, with Pod's hooks present where the launch templates carry them. */
export function readClaudeHooksForStatus(
  service: HookService,
  configPath: string,
  scriptPath: string,
  options: { claudeVersion?: string },
  enabled: boolean = podClaudeLaunchSettingsEnabled()
): HooksConfig | null {
  const config = readHooksJson(configPath)
  if (
    !config ||
    service.agent !== 'claude' ||
    !enabled ||
    !existsSync(`${getPodClaudeLaunchSettingsPrefix()}.command.json`)
  ) {
    return config
  }
  return applyManagedHooks(
    config,
    podManagedClaudeHook(service, scriptPath, options, false),
    getManagedScriptFileName(service.settings),
    getClaudeManagedHookPlan(options.claudeVersion)
  )
}

/** Remove: the launches lose Pod's hooks too. */
export function removeClaudeLaunchSettings(service: HookService): void {
  if (service.agent === 'claude') {
    removePodClaudeLaunchTemplates()
  }
}
