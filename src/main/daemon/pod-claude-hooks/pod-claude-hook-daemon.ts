// Fork-only (Pod): the Claude hook relay's place in the daemon. Main asks for it (Pod on macOS, see
// pod-claude-hook-daemon-env.ts); the daemon then serves it for this incarnation from
// `<daemon dir>/claude-hooks-<pid>/` and tells each PTY where that is and which session it is.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  POD_CLAUDE_RELAY_PORT_FILE,
  POD_CLAUDE_SETTINGS_DIR_ENV,
  POD_CLAUDE_SETTINGS_FILE,
  POD_CLAUDE_SETTINGS_STATUSLINE_FILE,
  POD_DAEMON_SESSION_ENV,
  podClaudeFlagSettingsFiles
} from '../../pod/agent-hook/pod-claude-flag-settings'
import { livePodLaneSession } from '../pod-lane/pod-lane-sessions'
import { POD_CLAUDE_PANE_ENV_KEYS, type PodClaudePaneEnv } from './pod-claude-hook-forward'
import { PodClaudeHookRelay, POD_CLAUDE_RELAY_PATH } from './pod-claude-hook-relay'

export const POD_CLAUDE_HOOK_RELAY_ENV = 'POD_CLAUDE_HOOK_RELAY'
const DIR_PREFIX = 'claude-hooks-'
const DIR_NAME = /^claude-hooks-([0-9]+)$/
/** A PTY's env is kept before its session is registered (pod-lane-sessions.ts); never pruned this young. */
const UNREGISTERED_GRACE_MS = 60_000

type Log = { log(event: string, details?: Record<string, unknown>): void }

let active: { dir: string; relay: PodClaudeHookRelay } | null = null
const panes = new Map<string, { env: PodClaudePaneEnv; at: number }>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

/** Earlier incarnations' dirs, settings and merged launcher files with them. */
function collectDeadDirs(parent: string): void {
  for (const name of readdirSync(parent)) {
    const pid = Number(DIR_NAME.exec(name)?.[1] ?? 0)
    if (pid > 0 && (pid === process.pid || !alive(pid))) {
      rmSync(join(parent, name), { recursive: true, force: true })
    }
  }
}

function paneEnv(sessionId: string): PodClaudePaneEnv | null {
  const pane = panes.get(sessionId)
  if (!pane || livePodLaneSession(sessionId)) {
    return pane?.env ?? null
  }
  if (Date.now() - pane.at > UNREGISTERED_GRACE_MS) {
    panes.delete(sessionId)
  }
  return null
}

export async function startPodClaudeHookRelay(deps: {
  socketPath: string
  log: Log
}): Promise<void> {
  const asked = process.env[POD_CLAUDE_HOOK_RELAY_ENV] === '1'
  // Why: the daemon's env seeds its PTYs'.
  delete process.env[POD_CLAUDE_HOOK_RELAY_ENV]
  if (!asked || active) {
    return
  }
  const parent = dirname(deps.socketPath)
  try {
    collectDeadDirs(parent)
    const relay = new PodClaudeHookRelay(paneEnv)
    const port = await relay.listen()
    const dir = join(parent, `${DIR_PREFIX}${process.pid}`)
    mkdirSync(dir, { mode: 0o700 })
    const files = podClaudeFlagSettingsFiles(
      {
        home: homedir(),
        relay: { url: `http://127.0.0.1:${port}${POD_CLAUDE_RELAY_PATH}`, token: relay.token }
      },
      { hooks: POD_CLAUDE_SETTINGS_FILE, statusLine: POD_CLAUDE_SETTINGS_STATUSLINE_FILE }
    )
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text, { mode: 0o600 })
    }
    // Last: the launcher takes this dir only once the port file names a live relay.
    writeFileSync(join(dir, POD_CLAUDE_RELAY_PORT_FILE), `${port}\n`, { mode: 0o600 })
    active = { dir, relay }
    deps.log.log('pod-claude-hook-relay', { port })
  } catch (error) {
    deps.log.log('pod-claude-hook-relay-failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** A PTY's env: the relay's dir and its own session, and the pane env the relay posts with. */
export function podClaudeHookPtyEnv(sessionId: string, env: Record<string, string>): void {
  delete env[POD_CLAUDE_SETTINGS_DIR_ENV]
  delete env[POD_DAEMON_SESSION_ENV]
  if (!active) {
    return
  }
  env[POD_CLAUDE_SETTINGS_DIR_ENV] = active.dir
  env[POD_DAEMON_SESSION_ENV] = sessionId
  for (const id of panes.keys()) {
    paneEnv(id)
  }
  panes.set(sessionId, {
    env: Object.fromEntries(POD_CLAUDE_PANE_ENV_KEYS.map((key) => [key, env[key]])),
    at: Date.now()
  })
}
