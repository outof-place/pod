import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/agent-hook/install-agent-hook.cjs')
const installAgentHook: unknown = Reflect.get(Object(installer), 'installAgentHook')

let root = ''
let hookPath = ''
let server: Server
let port = 0
const received: { headers: Record<string, unknown>; body: string }[] = []

function runHook(input: string, env: Record<string, string>) {
  return spawnSync(hookPath, { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } })
}

// Async: the server answering the hook runs on this test's event loop.
function runHookAsync(input: string, env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(hookPath, { env: { PATH: '/usr/bin:/bin', ...env } })
    child.on('close', resolve)
    child.stdin.end(input)
  })
}

describe.skipIf(process.platform !== 'darwin')('pod-agent-hook in the app bundle', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pod-agent-hook-pack-'))
    if (typeof installAgentHook !== 'function') {
      throw new Error('install-agent-hook.cjs exports no installAgentHook')
    }
    installAgentHook(join(root, 'Resources'), process.arch)
    hookPath = join(root, 'Resources', 'bin', 'pod-agent-hook')
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      request.on('end', () => {
        received.push({ headers: request.headers, body })
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0
  }, 180_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('is an executable that answers "{}" and stays silent outside a Pod pane', () => {
    expect(statSync(hookPath).mode & 0o111).not.toBe(0)
    const outside = runHook('{"hook_event_name":"Stop"}\n', {
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: 'tok'
    })
    expect(outside.status).toBe(0)
    expect(outside.stdout).toBe('{}\n')
    expect(outside.stderr).toBe('')
  })

  it("posts the hook JSON with the pane's metadata, as claude-hook.sh does", async () => {
    received.length = 0
    const status = await runHookAsync('{"hook_event_name":"Stop","cwd":"/tmp/zażółć"}\n\n', {
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: 'tok',
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1',
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      ORCA_PANE_KEY: 'tab-1:leaf-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'repo::/w',
      ORCA_AGENT_LAUNCH_TOKEN: 'lt'
    })
    expect(status).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0].body).toBe('{"hook_event_name":"Stop","cwd":"/tmp/zażółć"}')
    expect(received[0].headers['x-orca-agent-hook-token']).toBe('tok')
    const meta = Buffer.from(String(received[0].headers['x-orca-agent-hook-meta']), 'base64')
    expect(meta.toString('utf8').split('\x1f')).toEqual([
      'tab-1:leaf-1',
      'tab-1',
      'lt',
      'repo::/w',
      'production',
      '1'
    ])
    expect(String(received[0].headers['x-orca-agent-process'])).toMatch(
      /^\{"pid":\d+,"platform":"darwin","startTime":"\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}"\}$/
    )
  })
})
