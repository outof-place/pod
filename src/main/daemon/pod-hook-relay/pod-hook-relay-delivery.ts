// Fork-only (Pod): what the relay does with one hook event, as Pod's command hook does it
// (native/pod-agent-hook-macos/src/pod-agent-hook.c): the same request to the runtime's hook
// server, read from the endpoint file at send time, or the same spool line when nothing answers.
import { appendFileSync, chmodSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

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

/** Bytes the C client's urlencode keeps as they are (RFC 3986 unreserved). */
const UNRESERVED = new Uint8Array(256)
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~') {
  UNRESERVED[c.charCodeAt(0)] = 1
}
const HEX = Buffer.from('0123456789ABCDEF')
/** ~0.7 ms of encoding: the daemon's loop gets a turn between slices. */
const ENCODE_SLICE_BYTES = 256 * 1024

/** As curl --data-urlencode: a space as '+', the rest %XX. */
function urlencode(value: Buffer): Buffer {
  let length = value.length
  for (let i = 0; i < value.length; i++) {
    if (UNRESERVED[value[i]] === 0 && value[i] !== 0x20) {
      length += 2
    }
  }
  const out = Buffer.allocUnsafe(length)
  let at = 0
  for (let i = 0; i < value.length; i++) {
    const byte = value[i]
    if (UNRESERVED[byte] === 1) {
      out[at++] = byte
    } else if (byte === 0x20) {
      out[at++] = 0x2b
    } else {
      out[at++] = 0x25
      out[at++] = HEX[byte >> 4]
      out[at++] = HEX[byte & 15]
    }
  }
  return out
}

async function formBody(event: PodHookRelayEvent, endpoint: Endpoint): Promise<Buffer[]> {
  const { pane } = event
  const fields: [string, string][] = [
    ['paneKey', pane.paneKey],
    ['tabId', pane.tabId],
    ['launchToken', pane.launchToken],
    ['worktreeId', pane.worktreeId],
    ['env', endpoint.env],
    ['version', endpoint.version],
    ['agentProcess', event.agentProcess]
  ]
  const head = fields.map(([key, value]) => `${key}=${urlencode(Buffer.from(value)).toString()}`)
  const parts: Buffer[] = [Buffer.from(`${head.join('&')}&payload=`)]
  for (let at = 0; at < event.payload.length; at += ENCODE_SLICE_BYTES) {
    if (at > 0) {
      await nextTurn()
    }
    parts.push(urlencode(event.payload.subarray(at, at + ENCODE_SLICE_BYTES)))
  }
  return parts
}

async function post(event: PodHookRelayEvent, endpoint: Endpoint): Promise<boolean> {
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
  const body = raw ? [event.payload] : await formBody(event, endpoint)
  const length = body.reduce((sum, part) => sum + part.length, 0)
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(endpoint.port),
        method: 'POST',
        path: `/hook/${event.agent}`,
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { ...headers, 'Content-Length': String(length), Connection: 'close' }
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
    for (const part of body.slice(0, -1)) {
      req.write(part)
    }
    req.end(body.at(-1))
  })
}

/** The runtime replays these at its next start (claude-hook.sh spool_hook_event). Synchronous, as
 *  the C client's: a closing relay spools its backlog before the daemon exits. */
export function spoolPodHookRelayEvent(
  event: PodHookRelayEvent,
  now: number
): 'spooled' | 'skipped' {
  const { pane, payload } = event
  if (TOOL_EVENTS.some((name) => payload.includes(name)) || !pane.endpoint) {
    return 'skipped'
  }
  const dir = join(dirname(pane.endpoint), 'spool')
  const id = pane.paneKey.slice(-36).replace(/[/:]/g, '_')
  const file = join(dir, `pane-${id}.jsonl`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    let size = 0
    try {
      const info = statSync(file)
      if (info.isFile() && (now - info.mtimeMs) / 86_400_000 > SPOOL_MAX_AGE_DAYS) {
        truncateSync(file, 0)
      } else {
        size = info.size
      }
    } catch {
      // No spool yet.
    }
    if (size >= SPOOL_CAP_BYTES) {
      return 'skipped'
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
    const line = [Buffer.from(`\n${fields.slice(0, -1)},"payload":`), payload, Buffer.from('}\n')]
    appendFileSync(file, Buffer.concat(line), { mode: 0o600 })
    chmodSync(file, 0o600)
    return 'spooled'
  } catch {
    // A spool that can't be written loses the event, as the command hook does.
    return 'skipped'
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
  spoolPodHookRelayEvent(event, now())
  return 'spooled'
}
