import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The decouple renames Pod's ORCA_ names to POD_, but a terminal opened before that update keeps
// the ORCA_ ones, and a new claude in it runs the new client: it reads either spelling
// (pod-agent-hook.c env()). TODO(pod): drop with that fallback, after 2026-12-31.
const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
type Spelling = keyof typeof SPELLINGS

type Request = { url?: string; token?: string; body: string }

const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'
let dir = ''
let client = ''
let server: Server
let port = 0
let requests: Request[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-agent-hook-legacy-env-'))
  client = join(dir, 'pod-agent-hook')
  const source = join(process.cwd(), 'native', 'pod-agent-hook-macos', 'src', 'pod-agent-hook.c')
  if (process.platform === 'darwin') {
    execFileSync('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', client])
  }
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

/** A terminal's env with Pod's names in one spelling only. */
function terminalEnv(spelling: Spelling, names: Record<string, string>): Record<string, string> {
  const tmp = mkdtempSync(join(dir, `${spelling}-`))
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: tmp }
  for (const [name, value] of Object.entries(names)) {
    env[`${SPELLINGS[spelling]}${name}`] = value
  }
  return env
}

const paneNames = () => ({
  PANE_KEY: PANE,
  TAB_ID: 'tab-1',
  WORKTREE_ID: 'repo::/w',
  AGENT_LAUNCH_TOKEN: 'launch-1',
  AGENT_HOOK_ENV: 'production',
  AGENT_HOOK_VERSION: '7'
})

async function run(argv: string[], env: Record<string, string>, payload: string) {
  requests = []
  const child = spawn(client, argv, { env, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.end(payload)
  await new Promise((resolve) => child.on('close', resolve))
  return [...requests]
}

describe.runIf(process.platform === 'darwin')(
  "Pod's hook client in a terminal from either side of the decouple",
  () => {
    it.each(['legacy', 'current'] as const)(
      'reports a hook with only %s names',
      async (spelling) => {
        const env = terminalEnv(spelling, {
          ...paneNames(),
          AGENT_HOOK_PORT: String(port),
          AGENT_HOOK_TOKEN: 'tok-1'
        })
        const [request, ...more] = await run([], env, '{"hook_event_name":"Stop"}\n')
        expect(more).toEqual([])
        expect(request).toMatchObject({ url: '/hook/claude', token: 'tok-1' })
        const form = new URLSearchParams(request?.body)
        expect(Object.fromEntries(form)).toMatchObject({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'repo::/w',
          launchToken: 'launch-1',
          env: 'production',
          version: '7'
        })
        expect(JSON.parse(form.get('payload') ?? '')).toEqual({ hook_event_name: 'Stop' })
      }
    )

    it.each(['legacy', 'current'] as const)(
      "reads the endpoint file named by only %s names, in the runtime's two spellings",
      async (spelling) => {
        const env = terminalEnv(spelling, paneNames())
        const endpoint = join(dir, `endpoint-${spelling}.env`)
        const keys = (prefix: string) =>
          `${prefix}AGENT_HOOK_PORT=${port}\n${prefix}AGENT_HOOK_TOKEN=tok-2\n`
        writeFileSync(endpoint, `${keys(SPELLINGS.current)}${keys(SPELLINGS.legacy)}`)
        env[`${SPELLINGS[spelling]}AGENT_HOOK_ENDPOINT`] = endpoint
        const requested = await run([], env, '{"hook_event_name":"Stop"}')
        expect(requested.map(({ url, token }) => ({ url, token }))).toEqual([
          { url: '/hook/claude', token: 'tok-2' }
        ])
      }
    )

    it.each(['legacy', 'current'] as const)(
      'sends the statusLine with only %s names',
      async (spelling) => {
        const env = terminalEnv(spelling, {
          ...paneNames(),
          AGENT_HOOK_PORT: String(port),
          AGENT_HOOK_TOKEN: 'tok-1'
        })
        const payload =
          '{"cost":{"total_duration_ms":5000},"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1791800000}}}'
        const [request, ...more] = await run(['statusline'], env, payload)
        expect(more).toEqual([])
        expect(request?.token).toBe('tok-1')
        expect(new URLSearchParams(request?.body).get('paneKey')).toBe(PANE)
      }
    )
  }
)
