// Fork-only (Pod): Claude's agent-status hooks come with each launch in a Pod pane, not from
// ~/.claude/settings.json. Pod's launcher (product/agent-launcher/claude-settings.swift, `claude`
// first on every pane's PATH) passes `--settings` from templates written here: http hooks to the
// terminal daemon's relay (no process per event; the relay answers at once), or Pod's command hook
// client where the relay is missing; each also with Pod's statusLine. Written by
// pod-claude-hook-service.ts, which takes Pod's entries out of settings.json once.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  getSharedManagedScriptPath,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  type HooksConfig
} from '../../agent-hooks/installer-utils'
import { claudeVersionReaches } from '../../claude/claude-hook-event-versions'

/** PTY env: the templates' prefix (`<prefix>.http.json`, `<prefix>.command.json`). */
export const POD_CLAUDE_LAUNCH_SETTINGS_ENV = 'POD_CLAUDE_LAUNCH_SETTINGS'
/** The Claude its http events were measured on (agent-api's E2E on gate 2's mock); an older one
 *  gets the command hooks in both templates. */
export const CLAUDE_HTTP_HOOK_FIRST_VERSION = '2.1.296'
/** Events that stay on the command hook: SessionStart fires no http hook, TeammateIdle was never
 *  reached in that E2E. */
const COMMAND_ONLY_EVENTS = new Set(['SessionStart', 'TeammateIdle'])
const LAUNCHER_FILE_NAME = 'pod-agent-launcher'
const PREFIX_NAME = 'pod-claude-settings'

type LaunchOptions = {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  resourcesPath?: string | undefined
}

/** The launcher the app ships (Contents/Resources/bin), or POD_AGENT_LAUNCHER_BINARY's in a
 *  checkout whose panes have it first on PATH; null off macOS or with POD_CLAUDE_LAUNCH_SETTINGS=0. */
export function resolvePodAgentLauncher(options: LaunchOptions = {}): string | null {
  const env = options.env ?? process.env
  if (
    (options.platform ?? process.platform) !== 'darwin' ||
    env[POD_CLAUDE_LAUNCH_SETTINGS_ENV] === '0'
  ) {
    return null
  }
  const appResources: unknown = Reflect.get(process, 'resourcesPath')
  const resourcesPath =
    'resourcesPath' in options
      ? options.resourcesPath
      : typeof appResources === 'string'
        ? appResources
        : undefined
  return (
    [
      env.POD_AGENT_LAUNCHER_BINARY,
      resourcesPath ? join(resourcesPath, 'bin', LAUNCHER_FILE_NAME) : undefined
    ].find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path)) ??
    null
  )
}

/** On where Pod's launcher is (resolvePodAgentLauncher). */
export function podClaudeLaunchSettingsEnabled(options: LaunchOptions = {}): boolean {
  return resolvePodAgentLauncher(options) !== null
}

export function getPodClaudeLaunchSettingsPrefix(): string {
  return getSharedManagedScriptPath(PREFIX_NAME)
}

/** The command hooks, with an http hook for every measured event: the relay's address and the pane
 *  come from the launcher. */
function httpVariant(command: HooksConfig): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {}
  for (const [event, definitions] of Object.entries(command.hooks ?? {})) {
    hooks[event] = COMMAND_ONLY_EVENTS.has(event)
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
              'X-Orca-Agent-Process': '@@POD_AGENT_PROCESS@@',
              'X-Pod-Hook-Relay-Job-Dir': '$CLAUDE_JOB_DIR'
            },
            allowedEnvVars: ['CLAUDE_JOB_DIR']
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

export type PodClaudeStatusLine = { type: 'command'; command: string }

/** Template file names: `<prefix>.<kind>.json`, and `<kind>-statusline` with Pod's statusLine. */
const TEMPLATE_SUFFIXES = [
  '.command.json',
  '.http.json',
  '.command-statusline.json',
  '.http-statusline.json'
] as const

export function podClaudeLaunchTemplatesExist(
  prefix = getPodClaudeLaunchSettingsPrefix()
): boolean {
  return existsSync(`${prefix}.command.json`)
}

/** Whether the templates carry Pod's statusLine: the launcher takes it while the user has none. */
export function podClaudeLaunchStatusLineOn(prefix = getPodClaudeLaunchSettingsPrefix()): boolean {
  return existsSync(`${prefix}.command-statusline.json`)
}

export function writePodClaudeLaunchTemplates(
  command: HooksConfig,
  claudeVersion: string | undefined,
  statusLine: PodClaudeStatusLine | null,
  prefix: string = getPodClaudeLaunchSettingsPrefix()
): void {
  const http = claudeVersionReaches(claudeVersion, CLAUDE_HTTP_HOOK_FIRST_VERSION)
    ? httpVariant(command)
    : { hooks: command.hooks }
  const text = (value: object): string => `${JSON.stringify(value, null, 2)}\n`
  const kinds = [
    ['command', { hooks: command.hooks }],
    ['http', http]
  ] as const
  // Why the statusLine files first: the launcher takes `.command.json` as "Pod's hooks moved".
  for (const [kind, settings] of kinds) {
    if (statusLine) {
      writeIfChanged(`${prefix}.${kind}-statusline.json`, text({ ...settings, statusLine }))
    } else {
      rmSync(`${prefix}.${kind}-statusline.json`, { force: true })
    }
  }
  for (const [kind, settings] of kinds) {
    writeIfChanged(`${prefix}.${kind}.json`, text(settings))
  }
}

export function removePodClaudeLaunchTemplates(prefix = getPodClaudeLaunchSettingsPrefix()): void {
  for (const suffix of TEMPLATE_SUFFIXES) {
    rmSync(`${prefix}${suffix}`, { force: true })
  }
}

/** The hooks Claude gets with each launch, for the status check; null before the move. */
export function readPodClaudeLaunchHooks(
  prefix = getPodClaudeLaunchSettingsPrefix()
): HooksConfig | null {
  return podClaudeLaunchTemplatesExist(prefix) ? readHooksJson(`${prefix}.command.json`) : null
}

/** PTY env for the launcher; none until the templates are written. */
export function podClaudeLaunchSettingsEnv(): Record<string, string> {
  const prefix = getPodClaudeLaunchSettingsPrefix()
  return podClaudeLaunchSettingsEnabled() && podClaudeLaunchTemplatesExist(prefix)
    ? { [POD_CLAUDE_LAUNCH_SETTINGS_ENV]: prefix }
    : {}
}
