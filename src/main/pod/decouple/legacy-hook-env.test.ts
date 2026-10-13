import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getManagedScript } from '../../claude/hook-script'
import { getManagedStatusLineScript } from '../../claude/statusline-script'

// A terminal from before the decouple has only ORCA_ names; the scripts the update installs read
// POD_ ones (legacy-hook-env.ts). TODO(pod): drop with that fallback, after 2026-12-31.
const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
type Spelling = keyof typeof SPELLINGS
type Request = { url?: string; token?: string; body: string }

const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'
let dir = ''
let server: Server
let port = 0
const requests: Request[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-legacy-hook-env-'))
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({
        url: req.url,
        token: req.headers['x-orca-agent-hook-token']?.toString(),
        body
      })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/** The pane env in one spelling, pointing at an endpoint file the updated app wrote. */
function paneEnv(spelling: Spelling): Record<string, string> {
  const tmp = mkdtempSync(join(dir, `${spelling}-`))
  const endpoint = join(tmp, 'endpoint.env')
  const keys = (prefix: string): string =>
    `${prefix}AGENT_HOOK_PORT=${port}\n${prefix}AGENT_HOOK_TOKEN=tok-new\n`
  writeFileSync(endpoint, `${keys(SPELLINGS.current)}${keys(SPELLINGS.legacy)}`)
  const names = {
    PANE_KEY: PANE,
    TAB_ID: 'tab-1',
    WORKTREE_ID: 'repo::/w',
    AGENT_LAUNCH_TOKEN: 'launch-1',
    AGENT_HOOK_ENV: 'production',
    AGENT_HOOK_VERSION: '1',
    AGENT_HOOK_PORT: '9',
    AGENT_HOOK_TOKEN: 'tok-stale',
    AGENT_HOOK_ENDPOINT: endpoint
  }
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: tmp }
  for (const [name, value] of Object.entries(names)) {
    env[`${SPELLINGS[spelling]}${name}`] = value
  }
  return env
}

async function runScript(script: string, env: Record<string, string>, payload: string) {
  requests.length = 0
  const child = spawn('/bin/sh', ['-c', script], { env, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.end(payload)
  await new Promise((resolve) => child.on('close', resolve))
  return requests.splice(0)
}

describe.runIf(process.platform !== 'win32')(
  "Pod's POSIX hook scripts in a terminal from either side of the decouple",
  () => {
    it.each(['legacy', 'current'] as const)(
      "posts Claude's hook with only %s names",
      async (spelling) => {
        const [request, ...more] = await runScript(
          getManagedScript('posix'),
          paneEnv(spelling),
          '{"hook_event_name":"Stop"}'
        )
        expect(more).toEqual([])
        expect(request).toMatchObject({ url: '/hook/claude', token: 'tok-new' })
        const form = Object.fromEntries(new URLSearchParams(request?.body))
        expect(form).toMatchObject({ paneKey: PANE, tabId: 'tab-1', launchToken: 'launch-1' })
      }
    )

    it.each(['legacy', 'current'] as const)(
      "posts Claude's statusLine with only %s names",
      async (spelling) => {
        const payload =
          '{"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1791800000}}}'
        const [request, ...more] = await runScript(
          getManagedStatusLineScript('posix'),
          paneEnv(spelling),
          payload
        )
        expect(more).toEqual([])
        expect(request?.token).toBe('tok-new')
        expect(new URLSearchParams(request?.body).get('paneKey')).toBe(PANE)
      }
    )
  }
)
