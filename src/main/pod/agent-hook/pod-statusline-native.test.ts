import { spawn, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import { createManagedCommandMatcher } from '../../agent-hooks/installer-utils'
import { ClaudeHookService } from '../../claude/hook-service'
import { getManagedCommand, getStatusLineSlotState } from '../../claude/hook-settings'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import { podManagedStatusLineCommand, podStatusLineCommand } from './pod-statusline-native'

type Request = { method?: string; url?: string; type?: string; token?: string; body: string }
type Run = { stdout: string; status: number | null; stamp: string | null; requests: Request[] }
type Case = {
  name: string
  payload: string
  env?: Record<string, string | undefined>
  endpoint?: string
  stamp?: string
  /** The payload carries no clock, so each run reads its own: stamps may differ by a second. */
  wallClock?: boolean
}

const PANE = 'tab-1:550e8400-e29b-41d4-a716-446655440000'
const limits = '"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1791800000}}'
const timed = (ms: string) => `{"cost":{"total_duration_ms":${ms}},${limits}}`

let dir = ''
let client = ''
let script = ''
let server: Server
let port = 0
let requests: Request[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-statusline-'))
  client = join(dir, 'pod-agent-hook')
  const source = join(process.cwd(), 'native', 'pod-agent-hook-macos', 'src', 'pod-agent-hook.c')
  if (process.platform === 'darwin') {
    execFileSync('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', client])
  }
  script = join(dir, 'claude-statusline.sh')
  writeFileSync(script, getManagedStatusLineScript('posix'), { mode: 0o755 })
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        type: req.headers['content-type'],
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

async function run(argv: string[], scenario: Case, tag: string): Promise<Run> {
  const tmp = mkdtempSync(join(dir, `${tag}-`))
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: tmp }
  const vars = {
    ORCA_AGENT_HOOK_PORT: String(port),
    ORCA_AGENT_HOOK_TOKEN: 'tok-1',
    ORCA_PANE_KEY: PANE,
    ORCA_AGENT_HOOK_ENV: 'production',
    ORCA_AGENT_HOOK_VERSION: '7',
    CLAUDE_CONFIG_DIR: '/Users/e2e/.claude profiles/a',
    ...scenario.env
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (scenario.endpoint !== undefined) {
    env.ORCA_AGENT_HOOK_ENDPOINT = join(tmp, 'endpoint.env')
    writeFileSync(
      env.ORCA_AGENT_HOOK_ENDPOINT,
      scenario.endpoint.replaceAll('{port}', String(port))
    )
  }
  const stamp = join(tmp, stampFileFor(env.ORCA_PANE_KEY ?? ''))
  if (scenario.stamp !== undefined) {
    writeFileSync(stamp, scenario.stamp)
  }
  requests = []
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stdin.end(scenario.payload)
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve))
  return {
    stdout,
    status,
    stamp: existsSync(stamp) ? readFileSync(stamp, 'utf8') : null,
    requests: [...requests]
  }
}

/** The script's stamp naming: the leaf id, or a numeric leaf behind its safe tab id. */
function stampFileFor(paneKey: string): string {
  const leaf = paneKey.slice(paneKey.lastIndexOf(':') + 1)
  const tab = paneKey.includes(':') ? paneKey.slice(0, paneKey.lastIndexOf(':')) : paneKey
  const id = /^[0-9]+$/.test(leaf) && /^[A-Za-z0-9._-]+$/.test(tab) ? `${tab}_${leaf}` : leaf
  return `orca-claude-statusline-last-${id}`
}

const cases: Case[] = [
  { name: 'an empty payload', payload: '' },
  { name: 'a lone newline', payload: '\n' },
  { name: 'no rate_limits', payload: '{"cost":{"total_duration_ms":5000}}\n' },
  { name: 'rate_limits only inside a value', payload: '{"cwd":"/x/rate_limits"}\n' },
  { name: 'a background job', payload: timed('5000'), env: { CLAUDE_JOB_DIR: '/tmp/job' } },
  { name: 'no port', payload: timed('5000'), env: { ORCA_AGENT_HOOK_PORT: undefined } },
  { name: 'no token', payload: timed('5000'), env: { ORCA_AGENT_HOOK_TOKEN: undefined } },
  { name: 'no pane', payload: timed('5000'), env: { ORCA_PANE_KEY: undefined } },
  { name: 'a post', payload: `${timed('123456')}\n` },
  { name: 'trailing newlines', payload: `${timed('123456')}\n\n\n` },
  { name: 'no trailing newline', payload: timed('123456') },
  {
    name: 'text that must be encoded',
    payload: `{"cwd":"/a b/ąę & =?+%~",${limits},"cost":{"total_duration_ms":99999}}\nline two\t\n`
  },
  {
    name: 'a numeric leaf with a safe tab',
    payload: timed('42000'),
    env: { ORCA_PANE_KEY: 'tab.A_1:7' }
  },
  {
    name: 'a numeric leaf with an unsafe tab',
    payload: timed('42000'),
    env: { ORCA_PANE_KEY: 't/b:7' }
  },
  { name: 'a numeric key without a tab', payload: timed('42000'), env: { ORCA_PANE_KEY: '77' } },
  { name: 'throttled', payload: timed('123456'), stamp: '120' },
  { name: 'past the interval', payload: timed('123456'), stamp: '100' },
  { name: 'exactly the interval', payload: timed('123456'), stamp: '108' },
  { name: 'a stamp from the future', payload: timed('123456'), stamp: '200' },
  { name: 'a stamp with a leading zero', payload: timed('123456'), stamp: '0120' },
  { name: 'a stamp with a newline', payload: timed('123456'), stamp: '120\nmore' },
  { name: 'an empty stamp', payload: timed('123456'), stamp: '' },
  { name: 'spaces before the clock', payload: `{"total_duration_ms" : \n\t 61000,${limits}}` },
  { name: 'a clock with a leading zero', payload: timed('061000'), wallClock: true },
  { name: 'a 16-digit clock', payload: timed('1234567890123456'), wallClock: true },
  { name: 'no clock', payload: `{${limits}}`, wallClock: true },
  { name: 'a clock key with no colon after it', payload: `{${limits},"total_duration_ms" 5}` },
  {
    name: 'a clock key whose next colon is elsewhere',
    payload: `{"total_duration_ms" 5,${limits}}`,
    wallClock: true
  },
  {
    name: 'the endpoint file over a stale env',
    payload: timed('123456'),
    env: { ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_TOKEN: 'stale' },
    endpoint:
      'ORCA_AGENT_HOOK_PORT={port}\nORCA_AGENT_HOOK_TOKEN=tok-2\nORCA_AGENT_HOOK_ENV=dev\nORCA_AGENT_HOOK_VERSION=8\n'
  },
  { name: 'no config dir', payload: timed('123456'), env: { CLAUDE_CONFIG_DIR: undefined } },
  { name: 'a server that is down', payload: timed('123456'), env: { ORCA_AGENT_HOOK_PORT: '9' } }
]

describe.runIf(process.platform === 'darwin')('pod-agent-hook statusline', () => {
  it.each(cases)('does what claude-statusline.sh does: $name', async (scenario) => {
    const shell = await run(['/bin/sh', script], scenario, 'sh')
    const native = await run([client, 'statusline'], scenario, 'native')
    expect(native.stdout).toBe('')
    expect(native.status).toBe(0)
    expect({ ...native, stamp: null }).toEqual({ ...shell, stamp: null })
    if (scenario.wallClock && shell.stamp !== null && native.stamp !== null) {
      expect(Math.abs(Number(native.stamp) - Number(shell.stamp))).toBeLessThanOrEqual(1)
    } else {
      expect(native.stamp).toBe(shell.stamp)
    }
  })

  it('sends what the runtime parses for a post', async () => {
    const native = await run([client, 'statusline'], cases[8], 'native')
    expect(native.requests).toHaveLength(1)
    const [request] = native.requests
    expect(request).toMatchObject({
      method: 'POST',
      url: '/statusline/claude',
      type: 'application/x-www-form-urlencoded',
      token: 'tok-1'
    })
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      paneKey: PANE,
      configDir: '/Users/e2e/.claude profiles/a',
      env: 'production',
      version: '7',
      payload: timed('123456')
    })
    expect(native.stamp).toBe('123')
  })
})

describe('the managed statusLine command', () => {
  it('execs the client, else the script, else drains stdin', () => {
    const command = podStatusLineCommand('claude-statusline.sh')
    expect(command).toBe(
      'if [ -x "${HOME-}/.orca/agent-hooks/pod-agent-hook" ]; then exec "${HOME-}/.orca/agent-hooks/pod-agent-hook" statusline; fi; ' +
        'if [ -f "${HOME-}/.orca/agent-hooks/claude-statusline.sh" ]; then exec /bin/sh "${HOME-}/.orca/agent-hooks/claude-statusline.sh"; fi; ' +
        '{ command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :'
    )
  })
})

describe('installing the managed statusLine', () => {
  let home = ''
  let bundled = ''
  const scriptPath = () => join(home, '.orca', 'agent-hooks', 'claude-statusline.sh')
  const native = podStatusLineCommand('claude-statusline.sh')

  function freshHome(): void {
    home = mkdtempSync(join(tmpdir(), 'pod-statusline-home-'))
    homedirMock.mockReturnValue(home)
    bundled = join(home, 'bundled-pod-agent-hook')
    writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o755 })
  }

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('uses the client once it is copied beside the hooks, else the shell wrapper', () => {
    freshHome()
    expect(podManagedStatusLineCommand({ agent: 'claude' }, scriptPath(), bundled)).toBe(native)
    const installed = join(home, '.orca', 'agent-hooks', 'pod-agent-hook')
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(bundled, 'utf8'))
    expect(statSync(installed).mode & 0o777).toBe(0o755)
    const shell = getManagedCommand(scriptPath())
    expect(podManagedStatusLineCommand({ agent: 'openclaude' }, scriptPath(), bundled)).toBe(shell)
    expect(podManagedStatusLineCommand({ agent: 'claude' }, scriptPath(), null)).toBe(shell)
  })

  it('stays a managed slot, for this Pod and for one that predates the client', () => {
    expect(createManagedCommandMatcher('claude-statusline.sh')(native)).toBe(true)
    expect(getStatusLineSlotState({ statusLine: { type: 'command', command: native } })).toBe(
      'managed'
    )
  })

  it('replaces the shell entry once through the hook service, and leaves a user one alone', () => {
    freshHome()
    const settingsPath = join(home, '.claude', 'settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command).toBe(
      getManagedCommand(scriptPath())
    )

    vi.stubEnv('POD_AGENT_HOOK_BINARY', bundled)
    service.install({ claudeVersion: '2.1.296' })
    const written = readFileSync(settingsPath, 'utf8')
    expect(JSON.parse(written).statusLine).toEqual({ type: 'command', command: native })
    expect(readFileSync(scriptPath(), 'utf8')).toBe(getManagedStatusLineScript('local'))
    service.install({ claudeVersion: '2.1.296' })
    expect(readFileSync(settingsPath, 'utf8')).toBe(written)

    const user = { type: 'command', command: '~/.claude/my-statusline.sh' }
    writeFileSync(settingsPath, JSON.stringify({ statusLine: user }))
    service.install({ claudeVersion: '2.1.296' })
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine).toEqual(user)
  })
})
