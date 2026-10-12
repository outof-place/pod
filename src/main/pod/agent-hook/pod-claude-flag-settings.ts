// Fork-only (Pod): the settings Pod hands Claude with `--settings` (pod-agent-launcher), instead of
// writing its hooks into ~/.claude/settings.json. Self-contained: the terminal daemon builds it too,
// and a plain-Node daemon must not load the hook installers.
import { join } from 'node:path'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../../agent-hooks/hook-stdin-contract'

/** Claude from which this file is used: the version its http events were measured on (below), past
 *  exec-form `args` (2.1.139) and the plan's SessionEnd (2.1.261). An older Claude keeps
 *  settings.json entries. */
export const POD_CLAUDE_FLAG_SETTINGS_FIRST_VERSION = '2.1.296'

/** Events measured to fire an http hook with real Claude 2.1.296 (gate 2's mock: a Bash approved, a
 *  failing Bash, an Agent, /compact, an API error, /exit). SessionStart never fires one; TeammateIdle
 *  wasn't reached. Both stay on pod-agent-hook. */
export const POD_CLAUDE_HTTP_HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PostCompact',
  'SessionEnd'
] as const

/** Pod's managed plan for that Claude (claude-managed-hook-events.ts), in its order. */
const MANAGED_EVENTS: readonly { name: string; matcher?: string; async?: true }[] = [
  { name: 'SessionStart' },
  { name: 'UserPromptSubmit', async: true },
  { name: 'Stop', async: true },
  { name: 'StopFailure' },
  { name: 'SubagentStart', async: true },
  { name: 'SubagentStop', async: true },
  { name: 'TeammateIdle' },
  { name: 'PreToolUse', matcher: '*', async: true },
  { name: 'PostToolUse', matcher: '*', async: true },
  { name: 'PostToolUseFailure', matcher: '*', async: true },
  { name: 'PermissionRequest', matcher: '*' },
  { name: 'PostCompact' },
  { name: 'SessionEnd' }
]

/** = POD_AGENT_HOOK_FILE_NAME and the statusline script's name; this module can't import theirs. */
const POD_AGENT_HOOK = 'pod-agent-hook'
const STATUSLINE_SCRIPT = 'claude-statusline.sh'

/** Files the launcher picks from: the hooks alone, or with Pod's statusLine when the user has none. */
export const POD_CLAUDE_SETTINGS_FILE = 'settings.json'
export const POD_CLAUDE_SETTINGS_STATUSLINE_FILE = 'settings-statusline.json'
/** The runtime's copies beside pod-agent-hook (exec only), for terminals without a relay. Their
 *  presence is what tells the launcher Pod's hooks moved out of settings.json. */
export const POD_CLAUDE_FALLBACK_SETTINGS_FILE = 'claude-pod-settings.json'
export const POD_CLAUDE_FALLBACK_SETTINGS_STATUSLINE_FILE = 'claude-pod-settings-statusline.json'
/** The relay's port, beside the daemon's settings files; the launcher connects to it first. */
export const POD_CLAUDE_RELAY_PORT_FILE = 'relay.port'
/** Pane env: the daemon's settings dir and session (pod-claude-hook-relay.ts). */
export const POD_CLAUDE_SETTINGS_DIR_ENV = 'POD_CLAUDE_SETTINGS'
export const POD_DAEMON_SESSION_ENV = 'POD_DAEMON_SESSION'

export function podAgentHooksDir(home: string): string {
  return join(home, '.orca', 'agent-hooks')
}

/** The daemon's loopback relay (pod-claude-hook-relay.ts). */
export type PodClaudeHookRelay = { url: string; token: string }

type FlagHook = Record<string, unknown>
export type PodClaudeFlagSettings = {
  hooks: Record<string, { matcher?: string; hooks: FlagHook[] }[]>
  statusLine?: { type: 'command'; command: string }
}

/** Header variables: the pane's daemon session, the agent process the launcher recorded, and
 *  Claude's background-job dir (a job worker inherits a pane's env but doesn't run in it). */
export const POD_CLAUDE_HOOK_HEADER_ENV = [
  POD_DAEMON_SESSION_ENV,
  'POD_AGENT_PROCESS',
  'CLAUDE_JOB_DIR'
] as const

function relayHook(relay: PodClaudeHookRelay): FlagHook {
  return {
    type: 'http',
    url: relay.url,
    timeout: 2,
    headers: {
      'X-Pod-Token': relay.token,
      'X-Pod-Session': `$${POD_DAEMON_SESSION_ENV}`,
      'X-Pod-Agent-Process': '$POD_AGENT_PROCESS',
      'X-Pod-Job-Dir': '$CLAUDE_JOB_DIR'
    },
    allowedEnvVars: [...POD_CLAUDE_HOOK_HEADER_ENV]
  }
}

/** The client, else the statusline script (Pod still writes it), else a silent drain. The
 *  script's path keeps the slot recognisably managed, by this Pod and by one before the client. */
export function podStatusLineCommand(scriptFileName = STATUSLINE_SCRIPT): string {
  const client = `"\${HOME-}/.orca/agent-hooks/${POD_AGENT_HOOK}"`
  const script = `"\${HOME-}/.orca/agent-hooks/${scriptFileName}"`
  return [
    `if [ -x ${client} ]; then exec ${client} statusline; fi`,
    `if [ -f ${script} ]; then exec /bin/sh ${script}; fi`,
    POSIX_HOOK_STDIN_DRAIN_COMMAND
  ].join('; ')
}

/** Every managed event on pod-agent-hook (exec form), the measured ones on the relay when there is
 *  one, and Pod's statusLine when asked for. */
export function podClaudeFlagSettings(options: {
  home: string
  relay?: PodClaudeHookRelay
  statusLine?: boolean
}): PodClaudeFlagSettings {
  const command = join(podAgentHooksDir(options.home), POD_AGENT_HOOK)
  const http = new Set<string>(POD_CLAUDE_HTTP_HOOK_EVENTS)
  const hooks: PodClaudeFlagSettings['hooks'] = {}
  for (const event of MANAGED_EVENTS) {
    const exec: FlagHook = {
      type: 'command',
      command,
      args: [],
      timeout: 10,
      ...(event.async ? { async: true } : {})
    }
    const hook = options.relay && http.has(event.name) ? relayHook(options.relay) : exec
    hooks[event.name] = [{ ...(event.matcher ? { matcher: event.matcher } : {}), hooks: [hook] }]
  }
  return {
    hooks,
    ...(options.statusLine
      ? { statusLine: { type: 'command' as const, command: podStatusLineCommand() } }
      : {})
  }
}

/** Both variants as file contents, keyed by file name. */
export function podClaudeFlagSettingsFiles(
  options: { home: string; relay?: PodClaudeHookRelay },
  names: { hooks: string; statusLine: string }
): Record<string, string> {
  const text = (statusLine: boolean): string =>
    `${JSON.stringify(podClaudeFlagSettings({ ...options, statusLine }), null, 2)}\n`
  return { [names.hooks]: text(false), [names.statusLine]: text(true) }
}
