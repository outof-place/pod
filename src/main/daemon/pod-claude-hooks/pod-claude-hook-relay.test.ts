import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PodClaudePaneEnv } from './pod-claude-hook-forward'
import { PodClaudeHookRelay } from './pod-claude-hook-relay'

type Captured = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
type Case = {
  name: string
  payload: string
  env?: Record<string, string>
  endpoint?: string
  /** The runtime's port is closed. */
  down?: boolean
  /** What the client does with it. */
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
let delayMs = 0
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
  dir = mkdtempSync(join(tmpdir(), 'pod-claude-relay-'))
  client = join(dir, 'pod-agent-hook')
  const source = join(process.cwd(), 'native', 'pod-agent-hook-macos', 'src', 'pod-agent-hook.c')
  if (process.platform === 'darwin') {
    execFileSync('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', client])
    // The client reports its parent, this process, the way `ps -o lstart=` does in UTC.
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      env: { TZ: 'UTC0', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    }).trim()
    agentProcess = `{"pid":${process.pid},"platform":"darwin","startTime":"${lstart}"}`
  }
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('latin1')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body })
      setTimeout(() => res.end('ok'), delayMs)
    })
  })
  port = await listen(server)
  const closed = createServer()
  deadPort = await listen(closed)
  await new Promise((resolve) => closed.close(resolve))
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

function paneEnv(scenario: Case, root: string): Record<string, string> {
  const env: Record<string, string> = {
    ORCA_PANE_KEY: PANE,
    ORCA_TAB_ID: 'tab-1',
    ORCA_WORKTREE_ID: 'repo::/w/feature a',
    ORCA_AGENT_LAUNCH_TOKEN: 'launch-7',
    ORCA_AGENT_HOOK_PORT: String(scenario.down ? deadPort : port),
    ORCA_AGENT_HOOK_TOKEN: 'tok-1',
    ORCA_AGENT_HOOK_ENV: 'production',
    ORCA_AGENT_HOOK_VERSION: '7',
    ...scenario.env
  }
  if (scenario.endpoint !== undefined) {
    env.ORCA_AGENT_HOOK_ENDPOINT = join(root, 'endpoint.env')
    writeFileSync(
      env.ORCA_AGENT_HOOK_ENDPOINT,
      scenario.endpoint.replaceAll('{port}', String(scenario.down ? deadPort : port))
    )
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

function postToRelay(
  relayPort: number,
  headers: Record<string, string>,
  body: string,
  path = '/hook/claude'
): Promise<{ status?: number; body: string; ms: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: relayPort, method: 'POST', path, headers },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: text, ms: Date.now() - started })
        )
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function withRelay<T>(
  envFor: (session: string) => PodClaudePaneEnv | null,
  run: (relay: PodClaudeHookRelay, relayPort: number) => Promise<T>
): Promise<T> {
  const relay = new PodClaudeHookRelay(envFor)
  const relayPort = await relay.listen()
  try {
    return await run(relay, relayPort)
  } finally {
    relay.close()
  }
}

async function viaRelay(
  scenario: Case,
  extraHeaders: Record<string, string> = {}
): Promise<{ requests: Captured[]; spool: string[] }> {
  const root = mkdtempSync(join(dir, 'relay-'))
  const env = paneEnv(scenario, root)
  captured = []
  await withRelay(
    (session) => (session === 'session-1' ? env : null),
    async (relay, relayPort) => {
      const answer = await postToRelay(
        relayPort,
        {
          'Content-Type': 'application/json',
          'X-Pod-Token': relay.token,
          'X-Pod-Session': 'session-1',
          'X-Pod-Agent-Process': agentProcess,
          'X-Pod-Job-Dir': '',
          ...extraHeaders
        },
        scenario.payload
      )
      expect(answer).toMatchObject({ status: 200, body: '{}' })
      await relay.idle()
    }
  )
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
    name: 'an endpoint value too long for the client keeps the env value',
    payload: stop(),
    endpoint: `ORCA_AGENT_HOOK_PORT={port}\nORCA_AGENT_HOOK_ENV=${'e'.repeat(200)}\n`,
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
    name: 'a spool when the token is missing',
    payload: stop(),
    env: { ORCA_AGENT_HOOK_TOKEN: '' },
    endpoint: '',
    outcome: 'spool'
  },
  {
    name: 'nothing without a pane',
    payload: stop(),
    env: { ORCA_PANE_KEY: '' },
    endpoint: '',
    outcome: 'nothing'
  },
  { name: 'nothing for an empty payload', payload: '\n', outcome: 'nothing' }
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
    const relayed = await viaRelay(scenario, { 'X-Pod-Job-Dir': '/tmp/job' })
    expect(native).toEqual({ requests: [], spool: [] })
    expect(relayed).toEqual({ requests: [], spool: [] })
  })
})

describe('the relay', () => {
  const env = { ORCA_PANE_KEY: PANE, ORCA_AGENT_HOOK_TOKEN: 'tok-1' }
  const envFor = (session: string): PodClaudePaneEnv | null =>
    session === 'session-1' ? { ...env, ORCA_AGENT_HOOK_PORT: String(port) } : null

  it('answers before the runtime does', async () => {
    delayMs = 400
    try {
      await withRelay(envFor, async (relay, relayPort) => {
        captured = []
        const headers = { 'X-Pod-Token': relay.token, 'X-Pod-Session': 'session-1' }
        const answer = await postToRelay(relayPort, headers, stop())
        expect(answer).toMatchObject({ status: 200, body: '{}' })
        expect(answer.ms).toBeLessThan(200)
        await relay.idle()
        expect(captured).toHaveLength(1)
      })
    } finally {
      delayMs = 0
    }
  })

  it("forwards a pane's events in the order Claude sent them", async () => {
    await withRelay(envFor, async (relay, relayPort) => {
      captured = []
      const headers = { 'X-Pod-Token': relay.token, 'X-Pod-Session': 'session-1' }
      await Promise.all(
        Array.from({ length: 12 }, (_, n) => postToRelay(relayPort, headers, stop(`,"n":${n}`)))
      )
      await relay.idle()
      const order = captured.map((req) => /%22n%22%3A(\d+)/.exec(req.body)?.[1])
      expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)))
      expect(order).toHaveLength(12)
    })
  })

  it('refuses a wrong token or path, and forwards nothing for an unknown session', async () => {
    await withRelay(envFor, async (relay, relayPort) => {
      captured = []
      const good = { 'X-Pod-Token': relay.token, 'X-Pod-Session': 'session-1' }
      expect((await postToRelay(relayPort, { ...good, 'X-Pod-Token': 'x' }, stop())).status).toBe(
        403
      )
      expect((await postToRelay(relayPort, good, stop(), '/other')).status).toBe(403)
      const unknown = { ...good, 'X-Pod-Session': 'session-2' }
      expect(await postToRelay(relayPort, unknown, stop())).toMatchObject({
        status: 200,
        body: '{}'
      })
      await relay.idle()
      expect(captured).toEqual([])
    })
  })
})
