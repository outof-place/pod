// The relay against Pod's C hook client: the same cases, one capture server, the same requests and
// spool lines. After agent-api's parity test (pod/claude-hooks-flag-settings 6859217697).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PodHookRelay,
  POD_HOOK_RELAY_JOB_DIR_HEADER,
  POD_HOOK_RELAY_PANE_HEADER,
  POD_HOOK_RELAY_TOKEN_HEADER
} from './pod-hook-relay-server'

type Captured = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
type Case = {
  name: string
  payload: string
  env?: Record<string, string>
  endpoint: string
  /** The runtime's port is closed. */
  down?: boolean
  outcome: 'post' | 'spool' | 'nothing'
}

const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'
const COMPARED = [
  'host',
  'user-agent',
  'accept',
  'content-type',
  'content-length',
  'x-orca-agent-hook-token',
  'x-orca-agent-hook-meta-encoding',
  'x-orca-agent-hook-meta',
  'x-orca-agent-process'
]

let dir = ''
let client = ''
let server: Server
let port = 0
let deadPort = 0
let captured: Captured[] = []
let agentProcess = ''

function listen(target: Server): Promise<number> {
  return new Promise((resolve) =>
    target.listen(0, '127.0.0.1', () => {
      const address = target.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  )
}

beforeAll(async () => {
  if (process.platform !== 'darwin') {
    return
  }
  dir = mkdtempSync(join(tmpdir(), 'pod-hook-relay-parity-'))
  client = join(dir, 'pod-agent-hook')
  const source = join(process.cwd(), 'native', 'pod-agent-hook-macos', 'src', 'pod-agent-hook.c')
  execFileSync('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', client])
  // The client reports its parent, this process, the way `ps -o lstart=` does in UTC.
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    env: { TZ: 'UTC0', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    encoding: 'utf8'
  }).trim()
  agentProcess = `{"pid":${process.pid},"platform":"darwin","startTime":"${lstart}"}`
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('latin1')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.end('ok')
    })
  })
  port = await listen(server)
  const closed = createServer()
  deadPort = await listen(closed)
  await new Promise((resolve) => closed.close(resolve))
})

afterAll(async () => {
  if (process.platform !== 'darwin') {
    return
  }
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/** A pane's env as the runtime gives it: the endpoint file, and the same values beside it. */
function paneEnv(scenario: Case, root: string): Record<string, string> {
  const runtimePort = String(scenario.down ? deadPort : port)
  const endpoint = join(root, 'endpoint.env')
  writeFileSync(endpoint, scenario.endpoint.replaceAll('{port}', runtimePort))
  const env: Record<string, string> = {
    ORCA_PANE_KEY: PANE,
    ORCA_TAB_ID: 'tab-1',
    ORCA_WORKTREE_ID: 'repo::/w/feature a',
    ORCA_AGENT_LAUNCH_TOKEN: 'launch-7',
    ORCA_AGENT_HOOK_PORT: runtimePort,
    ORCA_AGENT_HOOK_TOKEN: 'tok-1',
    ORCA_AGENT_HOOK_ENV: 'production',
    ORCA_AGENT_HOOK_VERSION: '7',
    ORCA_AGENT_HOOK_ENDPOINT: endpoint,
    ...scenario.env
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
}

function spoolOf(root: string): string[] {
  const spool = join(root, 'spool')
  if (!existsSync(spool)) {
    return []
  }
  return readdirSync(spool).map(
    (name) =>
      `${name}:${readFileSync(join(spool, name), 'latin1').replace(/"receivedAt":\d+/g, '"receivedAt":N')}`
  )
}

async function viaClient(scenario: Case): Promise<{ requests: Captured[]; spool: string[] }> {
  const root = mkdtempSync(join(dir, 'client-'))
  const env = { PATH: '/usr/bin:/bin', HOME: root, ...paneEnv(scenario, root) }
  captured = []
  const child = spawn(client, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(scenario.payload)
  await new Promise((resolve) => child.on('close', resolve))
  return { requests: [...captured], spool: spoolOf(root) }
}

/** The pane header the launcher writes into each launch's settings (claude-settings.swift). */
function paneHeader(env: Record<string, string>): string {
  const fields = [
    env.ORCA_PANE_KEY ?? '',
    env.ORCA_TAB_ID ?? '',
    env.ORCA_AGENT_LAUNCH_TOKEN ?? '',
    env.ORCA_WORKTREE_ID ?? '',
    env.ORCA_AGENT_HOOK_ENV ?? '',
    env.ORCA_AGENT_HOOK_VERSION ?? '',
    env.ORCA_AGENT_HOOK_ENDPOINT ?? ''
  ]
  return Buffer.from(fields.join('\x1f')).toString('base64')
}

function post(relayPort: number, headers: Record<string, string>, body: string) {
  return new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: relayPort, method: 'POST', path: '/hook/claude', headers },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function viaRelay(
  scenario: Case,
  extraHeaders: Record<string, string> = {}
): Promise<{ requests: Captured[]; spool: string[] }> {
  const root = mkdtempSync(join(dir, 'relay-'))
  const env = paneEnv(scenario, root)
  captured = []
  const relayFilePath = join(root, 'relay.env')
  const relay = new PodHookRelay({
    relayFilePath,
    log: () => {},
    endpointAllowed: (endpoint) => endpoint === env.ORCA_AGENT_HOOK_ENDPOINT
  })
  await relay.start()
  try {
    const values = Object.fromEntries(
      readFileSync(relayFilePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    )
    const answer = await post(
      Number(values.POD_HOOK_RELAY_PORT),
      {
        'Content-Type': 'application/json',
        [POD_HOOK_RELAY_TOKEN_HEADER]: values.POD_HOOK_RELAY_TOKEN,
        [POD_HOOK_RELAY_PANE_HEADER]: paneHeader(env),
        'X-Orca-Agent-Process': agentProcess,
        ...extraHeaders
      },
      scenario.payload
    )
    expect(answer).toEqual({ status: 200, body: '{}\n' })
    await relay.idle()
  } finally {
    await relay.close()
  }
  return { requests: [...captured], spool: spoolOf(root) }
}

function comparable(requests: Captured[]): unknown[] {
  return requests.map((req) => ({
    method: req.method,
    url: req.url,
    body: req.body,
    headers: Object.fromEntries(
      COMPARED.map((name) => [
        name,
        name === 'host' ? req.headers.host?.replace(/:\d+$/, ':PORT') : req.headers[name]
      ])
    )
  }))
}

const stop = (extra = '') =>
  `{"session_id":"s-1","hook_event_name":"Stop","cwd":"/w/feature a"${extra}}`
const endpoint = 'ORCA_AGENT_HOOK_PORT={port}\nORCA_AGENT_HOOK_TOKEN=tok-file\n'

const cases: Case[] = [
  {
    name: 'a form post, trailing newlines stripped',
    payload: `${stop(',"q":"a b&c=d é 💥"')}\n\n`,
    endpoint,
    outcome: 'post'
  },
  {
    name: 'raw-json-v1 from the endpoint file',
    payload: `${stop()}\n`,
    endpoint: `${endpoint}ORCA_AGENT_HOOK_TRANSPORT=raw-json-v1\r\n`,
    outcome: 'post'
  },
  {
    name: "an endpoint file without a transport drops the env's",
    payload: stop(),
    env: { ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1' },
    endpoint,
    outcome: 'post'
  },
  {
    name: 'an endpoint value too long for the client keeps the pane value',
    payload: stop(),
    endpoint: `${endpoint}ORCA_AGENT_HOOK_ENV=${'e'.repeat(200)}\nORCA_AGENT_HOOK_VERSION=9\n`,
    outcome: 'post'
  },
  {
    name: 'a spooled Stop when the runtime is down',
    payload: stop(),
    endpoint,
    down: true,
    outcome: 'spool'
  },
  {
    name: 'a PreToolUse is never spooled',
    payload: '{"hook_event_name":"PreToolUse","tool_name":"Bash"}',
    endpoint,
    down: true,
    outcome: 'nothing'
  },
  {
    name: 'a spool when no token is known',
    payload: stop(),
    env: { ORCA_AGENT_HOOK_TOKEN: '' },
    endpoint: 'ORCA_AGENT_HOOK_PORT={port}\n',
    outcome: 'spool'
  },
  { name: 'nothing for an empty payload', payload: '\n', endpoint, outcome: 'nothing' }
]

describe.runIf(process.platform === 'darwin')('the relay against pod-agent-hook', () => {
  it.each(cases)('$name', async (scenario) => {
    const native = await viaClient(scenario)
    const relayed = await viaRelay(scenario)
    expect(comparable(relayed.requests)).toEqual(comparable(native.requests))
    expect(relayed.spool).toEqual(native.spool)
    expect(native.requests).toHaveLength(scenario.outcome === 'post' ? 1 : 0)
    expect(native.spool).toHaveLength(scenario.outcome === 'spool' ? 1 : 0)
  })

  it("drops a background job's event, as the client does", async () => {
    const scenario: Case = { name: 'job', payload: stop(), endpoint, outcome: 'nothing' }
    const native = await viaClient({ ...scenario, env: { CLAUDE_JOB_DIR: '/tmp/job' } })
    const relayed = await viaRelay(scenario, { [POD_HOOK_RELAY_JOB_DIR_HEADER]: '/tmp/job' })
    expect(native).toEqual({ requests: [], spool: [] })
    expect(relayed).toEqual({ requests: [], spool: [] })
  })
})
