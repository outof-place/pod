// Fork-only (Pod): one Claude hook event, delivered to the runtime the way pod-agent-hook delivers it
// (native/pod-agent-hook-macos/src/pod-agent-hook.c): the same request, and the same spool line when
// the runtime can't be reached. The parity test runs both against one server.
import { request as httpRequest } from 'node:http'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'

const SPOOL_CAP = 5242880
const CONNECT_TIMEOUT_MS = 500
const REQUEST_TIMEOUT_MS = 1500

export type PodClaudePaneEnv = Readonly<Record<string, string | undefined>>

/** The pane env pod-agent-hook reads; the daemon keeps this much of each PTY's. */
export const POD_CLAUDE_PANE_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT'
] as const

type Endpoint = { port: string; token: string; env: string; version: string; transport: string }

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** The endpoint file's KEY=value lines override the env, as `. "$ORCA_AGENT_HOOK_ENDPOINT"` does. */
function readEndpoint(env: PodClaudePaneEnv): Endpoint {
  const endpoint: Endpoint = {
    port: env.ORCA_AGENT_HOOK_PORT ?? '',
    token: env.ORCA_AGENT_HOOK_TOKEN ?? '',
    env: env.ORCA_AGENT_HOOK_ENV ?? '',
    version: env.ORCA_AGENT_HOOK_VERSION ?? '',
    transport: env.ORCA_AGENT_HOOK_TRANSPORT ?? ''
  }
  const path = env.ORCA_AGENT_HOOK_ENDPOINT ?? ''
  if (!path || !readable(path)) {
    return endpoint
  }
  endpoint.transport = ''
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return endpoint
  }
  // The client's buffers: a longer value leaves the env's in place.
  const slots: [string, keyof Endpoint, number][] = [
    ['ORCA_AGENT_HOOK_PORT', 'port', 64],
    ['ORCA_AGENT_HOOK_TOKEN', 'token', 512],
    ['ORCA_AGENT_HOOK_ENV', 'env', 128],
    ['ORCA_AGENT_HOOK_VERSION', 'version', 64],
    ['ORCA_AGENT_HOOK_TRANSPORT', 'transport', 64]
  ]
  for (const raw of text.split('\n')) {
    const line = raw.split('\r')[0]
    const eq = line.indexOf('=')
    if (eq === -1) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    for (const [name, slot, size] of slots) {
      if (key === name && Buffer.byteLength(value) < size) {
        endpoint[slot] = value
      }
    }
  }
  return endpoint
}

/** curl --data-urlencode: unreserved bytes as they are, space as '+', the rest %XX. */
function urlencode(value: Buffer): string {
  let out = ''
  for (const byte of value) {
    const c = String.fromCharCode(byte)
    if (/[A-Za-z0-9._~-]/.test(c)) {
      out += c
    } else if (byte === 0x20) {
      out += '+'
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Any answer counts, as `curl -sS` without -f. */
function post(port: string, headers: Record<string, string>, body: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const portNumber = Number.parseInt(port, 10)
    if (!(portNumber > 0 && portNumber < 65536)) {
      resolve(false)
      return
    }
    let settled = false
    const done = (answered: boolean): void => {
      if (!settled) {
        settled = true
        clearTimeout(deadline)
        req.destroy()
        resolve(answered)
      }
    }
    const req = httpRequest({
      host: '127.0.0.1',
      port: portNumber,
      method: 'POST',
      path: '/hook/claude',
      headers: {
        Host: `127.0.0.1:${port}`,
        'User-Agent': 'pod-agent-hook/1',
        Accept: '*/*',
        ...headers,
        'Content-Length': String(body.length),
        Connection: 'close'
      }
    })
    const deadline = setTimeout(() => done(false), REQUEST_TIMEOUT_MS)
    req.on('socket', (socket) => {
      const connect = setTimeout(() => done(false), CONNECT_TIMEOUT_MS)
      socket.once('connect', () => clearTimeout(connect))
      socket.once('close', () => clearTimeout(connect))
    })
    req.on('response', (res) => {
      res.resume()
      done(true)
    })
    req.on('error', () => done(false))
    req.end(body)
  })
}

/** As the client's: backslash and quote escaped, control bytes as spaces. */
function jsonEscape(value: string): string {
  let out = ''
  for (const c of value) {
    const code = c.charCodeAt(0)
    out += c === '\\' ? '\\\\' : c === '"' ? '\\"' : code < 0x20 || code === 0x7f ? ' ' : c
  }
  return out
}

/** The spool the runtime replays at its next start (claude-hook.sh spool_hook_event). */
function spool(env: PodClaudePaneEnv, payload: Buffer, agentProcess: string, nowMs: number): void {
  const text = payload.toString('latin1')
  if (
    text.includes('"PreToolUse"') ||
    text.includes('"PostToolUse"') ||
    text.includes('"PostToolUseFailure"')
  ) {
    return
  }
  const endpoint = env.ORCA_AGENT_HOOK_ENDPOINT ?? ''
  const pane = env.ORCA_PANE_KEY ?? ''
  if (!endpoint || !pane || !readable(endpoint)) {
    return
  }
  const dir = join(dirname(endpoint), 'spool')
  try {
    mkdirSync(dir, { mode: 0o777 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      return
    }
  }
  try {
    chmodSync(dir, 0o700)
  } catch {
    // As the client: a failed chmod doesn't stop the spool.
  }
  const id = pane.slice(-36).replace(/[/:]/g, '_')
  const file = join(dir, `pane-${id}.jsonl`)
  const nowSeconds = Math.trunc(nowMs / 1000)
  let size = 0
  try {
    const stat = statSync(file)
    size = stat.size
    if (stat.isFile() && Math.trunc((nowSeconds - Math.trunc(stat.mtimeMs / 1000)) / 86400) > 7) {
      closeSync(openSync(file, constants.O_WRONLY | constants.O_TRUNC))
      size = 0
    }
  } catch {
    size = 0
  }
  if (size >= SPOOL_CAP) {
    return
  }
  const fields = [
    `{"paneKey":"${jsonEscape(pane)}"`,
    `"tabId":"${jsonEscape(env.ORCA_TAB_ID ?? '')}"`,
    `"worktreeId":"${jsonEscape(env.ORCA_WORKTREE_ID ?? '')}"`,
    `"env":"${jsonEscape(env.ORCA_AGENT_HOOK_ENV ?? '')}"`,
    `"version":"${jsonEscape(env.ORCA_AGENT_HOOK_VERSION ?? '')}"`,
    `"launchToken":"${jsonEscape(env.ORCA_AGENT_LAUNCH_TOKEN ?? '')}"`,
    `"source":"claude","receivedAt":${nowSeconds * 1000}`,
    `"agentProcess":"${jsonEscape(agentProcess)}"`,
    '"payload":'
  ]
  const line = Buffer.concat([Buffer.from(`\n${fields.join(',')}`), payload, Buffer.from('}\n')])
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o644)
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    chmodSync(file, 0o600)
  } catch {
    // Best-effort, as the client's.
  }
}

/** One event: `payload` as Claude sent it, `agentProcess` as the launcher recorded it. */
export async function forwardPodClaudeHook(
  env: PodClaudePaneEnv,
  body: Buffer,
  agentProcess: string,
  now: () => number = Date.now
): Promise<void> {
  let end = body.length
  while (end > 0 && body[end - 1] === 0x0a) {
    end -= 1
  }
  const payload = body.subarray(0, end)
  if (payload.length === 0) {
    return
  }
  const pane = env.ORCA_PANE_KEY ?? ''
  const agent = pane ? agentProcess : ''
  const endpoint = readEndpoint(env)
  if (!endpoint.port || !endpoint.token || !pane) {
    spool(env, payload, agent, now())
    return
  }
  let headers: Record<string, string>
  let request: Buffer
  if (endpoint.transport === 'raw-json-v1') {
    const meta = [
      pane,
      env.ORCA_TAB_ID ?? '',
      env.ORCA_AGENT_LAUNCH_TOKEN ?? '',
      env.ORCA_WORKTREE_ID ?? '',
      endpoint.env,
      endpoint.version
    ].join('\x1f')
    headers = {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token,
      'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
      'X-Orca-Agent-Hook-Meta': Buffer.from(meta).toString('base64'),
      'X-Orca-Agent-Process': agent
    }
    request = payload
  } else {
    headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Orca-Agent-Hook-Token': endpoint.token
    }
    const form: [string, string][] = [
      ['paneKey', pane],
      ['tabId', env.ORCA_TAB_ID ?? ''],
      ['launchToken', env.ORCA_AGENT_LAUNCH_TOKEN ?? ''],
      ['worktreeId', env.ORCA_WORKTREE_ID ?? ''],
      ['env', endpoint.env],
      ['version', endpoint.version],
      ['agentProcess', agent]
    ]
    const encoded = form.map(([key, value]) => `${key}=${urlencode(Buffer.from(value))}`)
    request = Buffer.from(`${encoded.join('&')}&payload=${urlencode(payload)}`)
  }
  if (!(await post(endpoint.port, headers, request))) {
    spool(env, payload, agent, now())
  }
}
