// Fork-only (Pod): what the relay does with one hook event, as Pod's command hook does it
// (native/pod-agent-hook-macos/src/pod-agent-hook.c): the same request to the runtime's hook
// server, read from the endpoint file at send time, or the same spool line when nothing answers.
import { appendFile, chmod, mkdir, readFile, stat, truncate } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, join } from 'node:path'

/** What the launcher wrote into the per-launch settings, base64 of \x1f-joined fields. */
export type PodHookRelayPane = {
  paneKey: string
  tabId: string
  launchToken: string
  worktreeId: string
  /** ORCA_AGENT_HOOK_ENV / _VERSION of the pane's environment (the spool's). */
  env: string
  version: string
  /** ORCA_AGENT_HOOK_ENDPOINT: the runtime's endpoint file. */
  endpoint: string
}

export type PodHookRelayEvent = {
  agent: string
  pane: PodHookRelayPane
  /** X-Orca-Agent-Process as the launcher wrote it: claude's pid and start time. */
  agentProcess: string
  payload: Buffer
}

const PANE_FIELDS = 7
const CONNECT_TIMEOUT_MS = 500
const REQUEST_TIMEOUT_MS = 1_500
const SPOOL_CAP_BYTES = 5_242_880
const SPOOL_MAX_AGE_DAYS = 7
const TOOL_EVENTS = ['"PreToolUse"', '"PostToolUse"', '"PostToolUseFailure"']

export function decodePodHookRelayPane(header: string | undefined): PodHookRelayPane | null {
  if (!header) {
    return null
  }
  const fields = Buffer.from(header, 'base64').toString('utf8').split('\x1f')
  if (fields.length !== PANE_FIELDS || fields[0] === '') {
    return null
  }
  const [paneKey, tabId, launchToken, worktreeId, env, version, endpoint] = fields
  return { paneKey, tabId, launchToken, worktreeId, env, version, endpoint }
}

type Endpoint = { port: string; token: string; env: string; version: string; transport: string }

/** The endpoint file's KEY=value lines; the pane's own values where it has none. */
async function readEndpoint(pane: PodHookRelayPane): Promise<Endpoint | null> {
  let text: string
  try {
    text = await readFile(pane.endpoint, 'utf8')
  } catch {
    return null
  }
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      values.set(line.slice(0, eq), line.slice(eq + 1))
    }
  }
  const port = values.get('ORCA_AGENT_HOOK_PORT') ?? ''
  const token = values.get('ORCA_AGENT_HOOK_TOKEN') ?? ''
  if (!port || !token) {
    return null
  }
  return {
    port,
    token,
    env: values.get('ORCA_AGENT_HOOK_ENV') ?? pane.env,
    version: values.get('ORCA_AGENT_HOOK_VERSION') ?? pane.version,
    transport: values.get('ORCA_AGENT_HOOK_TRANSPORT') ?? ''
  }
}

function formBody(event: PodHookRelayEvent, endpoint: Endpoint): Buffer {
  const { pane } = event
  // Why: the C client's encoding (RFC 3986 unreserved kept), not URLSearchParams' '+' for a space.
  const encode = (value: string | Buffer): string =>
    Array.from(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'), (byte) => {
      const c = String.fromCharCode(byte)
      return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }).join('')
  const fields: [string, string][] = [
    ['paneKey', pane.paneKey],
    ['tabId', pane.tabId],
    ['launchToken', pane.launchToken],
    ['worktreeId', pane.worktreeId],
    ['env', endpoint.env],
    ['version', endpoint.version],
    ['agentProcess', event.agentProcess]
  ]
  return Buffer.from(
    `${fields.map(([key, value]) => `${key}=${encode(value)}`).join('&')}&payload=${encode(event.payload)}`
  )
}

function post(event: PodHookRelayEvent, endpoint: Endpoint): Promise<boolean> {
  const { pane } = event
  const raw = endpoint.transport === 'raw-json-v1'
  const meta = [
    pane.paneKey,
    pane.tabId,
    pane.launchToken,
    pane.worktreeId,
    endpoint.env,
    endpoint.version
  ].join('\x1f')
  const headers: Record<string, string> = raw
    ? {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.token,
        'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
        'X-Orca-Agent-Hook-Meta': Buffer.from(meta, 'utf8').toString('base64'),
        'X-Orca-Agent-Process': event.agentProcess
      }
    : {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': endpoint.token
      }
  const body = raw ? event.payload : formBody(event, endpoint)
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(endpoint.port),
        method: 'POST',
        path: `/hook/${event.agent}`,
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { ...headers, 'Content-Length': String(body.length), Connection: 'close' }
      },
      (res) => {
        // As curl -sS without -f: any answer is delivered.
        res.resume()
        resolve(true)
      }
    )
    const connectTimer = setTimeout(() => req.destroy(), CONNECT_TIMEOUT_MS)
    req.on('socket', (socket) => socket.once('connect', () => clearTimeout(connectTimer)))
    req.on('timeout', () => req.destroy())
    req.on('error', () => {
      clearTimeout(connectTimer)
      resolve(false)
    })
    req.on('close', () => clearTimeout(connectTimer))
    req.end(body)
  })
}

/** The runtime replays these at its next start (claude-hook.sh spool_hook_event). */
async function spool(event: PodHookRelayEvent, now: number): Promise<void> {
  const text = event.payload.toString('utf8')
  const { pane } = event
  if (TOOL_EVENTS.some((name) => text.includes(name)) || !pane.endpoint) {
    return
  }
  const dir = join(dirname(pane.endpoint), 'spool')
  const id = pane.paneKey.slice(-36).replace(/[/:]/g, '_')
  const file = join(dir, `pane-${id}.jsonl`)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    let size = 0
    try {
      const info = await stat(file)
      if (info.isFile() && (now - info.mtimeMs) / 86_400_000 > SPOOL_MAX_AGE_DAYS) {
        await truncate(file, 0)
      } else {
        size = info.size
      }
    } catch {
      // No spool yet.
    }
    if (size >= SPOOL_CAP_BYTES) {
      return
    }
    const fields = JSON.stringify({
      paneKey: pane.paneKey,
      tabId: pane.tabId,
      worktreeId: pane.worktreeId,
      env: pane.env,
      version: pane.version,
      launchToken: pane.launchToken,
      source: event.agent,
      receivedAt: Math.floor(now / 1000) * 1000,
      agentProcess: event.agentProcess
    })
    await appendFile(file, `\n${fields.slice(0, -1)},"payload":${text}}\n`, { mode: 0o600 })
    await chmod(file, 0o600)
  } catch {
    // A spool that can't be written loses the event, as the command hook does.
  }
}

/** Delivered, or spooled when the runtime didn't answer. */
export async function deliverPodHookRelayEvent(
  event: PodHookRelayEvent,
  now: () => number = Date.now
): Promise<'delivered' | 'spooled'> {
  const endpoint = await readEndpoint(event.pane)
  if (endpoint && (await post(event, endpoint))) {
    return 'delivered'
  }
  await spool(event, now())
  return 'spooled'
}
