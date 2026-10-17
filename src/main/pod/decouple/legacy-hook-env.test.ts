import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getManagedScript } from '../../claude/hook-script'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import { ENV_DECOUPLED } from '../../../shared/pod-legacy-env-names'

// A terminal from before the decouple has only ORCA_ names; the scripts the update installs read
// POD_ ones (legacy-hook-env.ts), and only in a Pod terminal, whose endpoint lies in the data
// folder of the Pod that wrote the script. TODO(pod): drop with that fallback, after 2026-12-31.
const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
type Spelling = keyof typeof SPELLINGS
type Request = { url?: string; token?: string; body: string }

const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'
const STATUS_LINE = '{"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1791800000}}}'
let dir = ''
let support = ''
let server: Server
let port = 0
const requests: Request[] = []

beforeAll(async () => {
  // tmpdir() is /var/folders/…, which resolves to /private/var/…: the gate compares resolved paths.
  dir = mkdtempSync(join(tmpdir(), 'pod-legacy-hook-env-'))
  support = join(dir, 'Library', 'Application Support')
  for (const folder of ['Pod', 'Pod Dev', 'Pod2', 'orca']) {
    mkdirSync(join(support, folder), { recursive: true })
  }
  symlinkSync(join(support, 'orca'), join(support, 'Pod', 'to-orca'))
  // The runtime that writes the scripts is this Pod, whose data folder is Pod's.
  vi.stubEnv(`${SPELLINGS.current}USER_DATA_PATH`, join(support, 'Pod'))
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
  vi.unstubAllEnvs()
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

/** An endpoint file the updated app wrote, in a folder below an app's data folder. */
function endpointIn(dataFolder: string): string {
  const hooks = join(support, dataFolder, 'agent-hooks')
  mkdirSync(hooks, { recursive: true })
  const endpoint = join(mkdtempSync(join(hooks, 'pane-')), 'endpoint.env')
  const keys = (prefix: string): string =>
    `${prefix}AGENT_HOOK_PORT=${port}\n${prefix}AGENT_HOOK_TOKEN=tok-new\n`
  writeFileSync(endpoint, `${keys(SPELLINGS.current)}${keys(SPELLINGS.legacy)}`)
  return endpoint
}

/** The pane env in one spelling, pointing at `endpoint`. */
function paneEnv(spelling: Spelling, endpoint = endpointIn('Pod')): Record<string, string> {
  const tmp = mkdtempSync(join(dir, `${spelling}-`))
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
  const child = spawn('/bin/sh', ['-c', script], { env, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.stdin.end(payload)
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { requests: requests.splice(0), code, stderr }
}

describe.runIf(process.platform !== 'win32')(
  "Pod's POSIX hook scripts in a terminal from either side of the decouple",
  () => {
    it.each(['legacy', 'current'] as const)(
      "posts Claude's hook with only %s names",
      async (spelling) => {
        const { requests: posted } = await runScript(
          getManagedScript('posix'),
          paneEnv(spelling),
          '{"hook_event_name":"Stop"}'
        )
        const [request, ...more] = posted
        expect(more).toEqual([])
        expect(request).toMatchObject({ url: '/hook/claude', token: 'tok-new' })
        const form = Object.fromEntries(new URLSearchParams(request?.body))
        expect(form).toMatchObject({ paneKey: PANE, tabId: 'tab-1', launchToken: 'launch-1' })
      }
    )

    it.each(['legacy', 'current'] as const)(
      "posts Claude's statusLine with only %s names",
      async (spelling) => {
        const { requests: posted } = await runScript(
          getManagedStatusLineScript('posix'),
          paneEnv(spelling),
          STATUS_LINE
        )
        const [request, ...more] = posted
        expect(more).toEqual([])
        expect(request?.token).toBe('tok-new')
        expect(new URLSearchParams(request?.body).get('paneKey')).toBe(PANE)
      }
    )

    // Orca.app's terminal, a dev Pod's, one whose name only starts with Pod's, a folder symlinked
    // out of Pod's into Orca's, and an endpoint file in Pod's folder symlinked to Orca's. Hooks
    // fail open: no output, exit 0.
    it.runIf(ENV_DECOUPLED).each([
      ['orca', () => endpointIn('orca')],
      ['Pod Dev', () => endpointIn('Pod Dev')],
      ['Pod2', () => endpointIn('Pod2')],
      ['Pod/to-orca', () => endpointIn('Pod/to-orca')],
      [
        'a symlinked endpoint file',
        () => {
          const link = join(mkdtempSync(join(support, 'Pod', 'pane-')), 'endpoint.env')
          symlinkSync(endpointIn('orca'), link)
          return link
        }
      ]
    ] as const)('posts nothing, silently, from %s', async (_label, endpoint) => {
      const env = paneEnv('legacy', endpoint())
      for (const [script, payload] of [
        [getManagedScript('posix'), '{"hook_event_name":"Stop"}'],
        [getManagedStatusLineScript('posix'), STATUS_LINE]
      ] as const) {
        expect(await runScript(script, env, payload)).toEqual({ requests: [], code: 0, stderr: '' })
      }
    })
  }
)
