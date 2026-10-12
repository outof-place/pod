import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Session } from '../session'
import { registerPodLaneSession } from '../pod-lane/pod-lane-sessions'
import { podClaudeHookPtyEnv, startPodClaudeHookRelay } from './pod-claude-hook-daemon'

let root = ''
let runtime: Server
let runtimePort = 0
const received: string[] = []

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pod-claude-daemon-'))
  runtime = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push(body)
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
  const address = runtime.address()
  runtimePort = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  await new Promise((resolve) => runtime.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe("the daemon's Claude hook relay", () => {
  it('leaves PTYs alone until main asks for it', () => {
    const env: Record<string, string> = { POD_DAEMON_SESSION: 'stale', POD_CLAUDE_SETTINGS: '/x' }
    podClaudeHookPtyEnv('session-0', env)
    expect(env).toEqual({})
  })

  it('serves this incarnation from its own dir, collects dead ones, and tells each PTY', async () => {
    const daemonDir = join(root, 'daemon')
    mkdirSync(daemonDir)
    // A dead daemon's dir (a pid no process has) and a live one's (this test runner's parent).
    const dead = spawn('/usr/bin/true')
    await new Promise((resolve) => dead.on('close', resolve))
    mkdirSync(join(daemonDir, `claude-hooks-${dead.pid}`))
    mkdirSync(join(daemonDir, `claude-hooks-${process.ppid}`))
    const logged: string[] = []
    process.env.POD_CLAUDE_HOOK_RELAY = '1'
    await startPodClaudeHookRelay({
      socketPath: join(daemonDir, 'daemon-v45.sock'),
      log: { log: (event) => logged.push(event) }
    })
    expect(process.env.POD_CLAUDE_HOOK_RELAY).toBeUndefined()
    expect(logged).toEqual(['pod-claude-hook-relay'])
    expect(existsSync(join(daemonDir, `claude-hooks-${dead.pid}`))).toBe(false)
    expect(existsSync(join(daemonDir, `claude-hooks-${process.ppid}`))).toBe(true)

    const dir = join(daemonDir, `claude-hooks-${process.pid}`)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const name of ['settings.json', 'settings-statusline.json', 'relay.port']) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    }
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    const relayHook = settings.hooks.Stop[0].hooks[0]
    expect(relayHook.url).toBe(
      `http://127.0.0.1:${readFileSync(join(dir, 'relay.port'), 'utf8').trim()}/hook/claude`
    )

    const env: Record<string, string> = {
      ORCA_PANE_KEY: 'tab-1:leaf',
      ORCA_AGENT_HOOK_PORT: String(runtimePort),
      ORCA_AGENT_HOOK_TOKEN: 'tok',
      HOME: '/Users/e2e'
    }
    podClaudeHookPtyEnv('session-1', env)
    expect(env.POD_CLAUDE_SETTINGS).toBe(dir)
    expect(env.POD_DAEMON_SESSION).toBe('session-1')

    const headers = {
      'X-Pod-Token': relayHook.headers['X-Pod-Token'],
      'X-Pod-Session': 'session-1'
    }
    const stop = '{"hook_event_name":"Stop"}'
    // Not yet a session the daemon serves: answered, not forwarded.
    expect(await post(relayHook.url, headers, stop)).toBe(200)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only these two fields.
    registerPodLaneSession({ sessionId: 'session-1', isAlive: true } as unknown as Session)
    expect(await post(relayHook.url, headers, stop)).toBe(200)
    await expect.poll(() => received.length).toBe(1)
    expect(received[0]).toContain('paneKey=tab-1%3Aleaf')
  })
})
