import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../../product/agent-launcher/install-agent-launcher.cjs')
const installAgentLauncher: unknown = Reflect.get(Object(installer), 'installAgentLauncher')

let root = ''
let binDir = ''
let home = ''
let hooksDir = ''
let realDir = ''

const HOOKS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/pod/agent-hook' }] }] } }
const WITH_STATUS = { ...HOOKS, statusLine: { type: 'command', command: 'pod-status' } }

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

/** The agent's argv, one per line, then the agent process the launcher recorded. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): { argv: string[]; agentProcess: string; pid: number } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? root,
    env: {
      PATH: [binDir, realDir, '/usr/bin', '/bin'].join(':'),
      HOME: home,
      ORCA_PANE_KEY: 'tab-1:leaf',
      ...options.env
    }
  })
  expect(result.status, result.stderr).toBe(0)
  const lines = result.stdout.split('\n').filter(Boolean)
  return {
    argv: lines.filter((line) => line.startsWith('[')).map((line) => line.slice(1, -1)),
    agentProcess: lines.find((line) => line.startsWith('AP='))?.slice(3) ?? '',
    pid: Number(lines.find((line) => line.startsWith('PID='))?.slice(4))
  }
}

describe.skipIf(process.platform !== 'darwin')("pod-agent-launcher's Claude settings", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-launcher-settings-'))
    binDir = join(root, 'Resources', 'bin')
    mkdirSync(binDir, { recursive: true })
    if (typeof installAgentLauncher !== 'function') {
      throw new Error('install-agent-launcher.cjs exports no installAgentLauncher')
    }
    installAgentLauncher(join(root, 'Resources'), process.arch)
    realDir = join(root, 'real')
    mkdirSync(realDir)
    for (const name of ['claude', 'codex']) {
      writeFileSync(
        join(realDir, name),
        '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\necho "AP=$POD_AGENT_PROCESS"\necho "PID=$$"\n'
      )
      chmodSync(join(realDir, name), 0o755)
    }
  }, 180_000)

  beforeEach(() => {
    home = mkdtempSync(join(root, 'home-'))
    hooksDir = join(home, '.orca', 'agent-hooks')
    write(join(hooksDir, 'claude-pod-settings.json'), HOOKS)
    write(join(hooksDir, 'claude-pod-settings-statusline.json'), WITH_STATUS)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("passes Pod's settings first, and records the agent process as pod-agent-hook would", () => {
    const { argv, agentProcess, pid } = run('claude', ['-p', 'hi'])
    expect(argv).toEqual([
      '--settings',
      join(hooksDir, 'claude-pod-settings-statusline.json'),
      '-p',
      'hi'
    ])
    expect(JSON.parse(agentProcess)).toMatchObject({ pid, platform: 'darwin' })
    expect(JSON.parse(agentProcess).startTime).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/)
  })

  it('changes nothing outside a Pod terminal, before the move, or for other agents', () => {
    expect(run('claude', ['x'], { env: { ORCA_PANE_KEY: '' } }).argv).toEqual(['x'])
    expect(run('codex', ['x']).argv).toEqual(['x'])
    rmSync(join(hooksDir, 'claude-pod-settings.json'))
    expect(run('claude', ['x']).argv).toEqual(['x'])
  })

  it("leaves out Pod's statusLine where the user has one, or turned Pod's off", () => {
    const hooksOnly = ['--settings', join(hooksDir, 'claude-pod-settings.json')]
    const project = join(root, `project-${Date.now()}`)
    mkdirSync(join(project, 'a', 'b'), { recursive: true })
    write(join(project, '.claude', 'settings.local.json'), { statusLine: { command: 'mine' } })
    expect(run('claude', [], { cwd: join(project, 'a', 'b') }).argv).toEqual(hooksOnly)
    const profile = join(home, 'profile')
    write(join(profile, 'settings.json'), { statusLine: { command: 'mine' } })
    expect(run('claude', [], { env: { CLAUDE_CONFIG_DIR: profile } }).argv).toEqual(hooksOnly)
    write(join(home, '.claude', 'settings.json'), { statusLine: { command: 'mine' } })
    expect(run('claude', []).argv).toEqual(hooksOnly)
    rmSync(join(home, '.claude', 'settings.json'))
    rmSync(join(hooksDir, 'claude-pod-settings-statusline.json'))
    expect(run('claude', []).argv).toEqual(hooksOnly)
  })

  it("takes the daemon's settings while its relay answers", async () => {
    const daemonDir = join(home, 'daemon', 'claude-hooks-1')
    write(join(daemonDir, 'settings-statusline.json'), WITH_STATUS)
    const server: Server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    write(join(daemonDir, 'relay.port'), `${port}\n`)
    const env = { POD_CLAUDE_SETTINGS: daemonDir }
    expect(run('claude', [], { env }).argv[1]).toBe(join(daemonDir, 'settings-statusline.json'))
    await new Promise((resolve) => server.close(resolve))
    expect(run('claude', [], { env }).argv[1]).toBe(
      join(hooksDir, 'claude-pod-settings-statusline.json')
    )
  })

  it("merges a user's own --settings into one file, their keys and statusLine first", () => {
    const user = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], Notification: [] },
      statusLine: { type: 'command', command: 'mine' }
    }
    write(join(root, 'user.json'), `${JSON.stringify(user, null, 2)}\n`)
    const fromFile = run('claude', ['--settings', join(root, 'user.json'), '-c']).argv
    expect(fromFile[0]).toBe('--settings')
    expect(fromFile[1]).toMatch(new RegExp(`^${hooksDir}/merged-\\d+-\\w+\\.json$`))
    expect(fromFile[2]).toBe('-c')
    expect(JSON.parse(readFileSync(fromFile[1], 'utf8'))).toEqual({
      model: 'opus',
      hooks: {
        Stop: [user.hooks.Stop[0], HOOKS.hooks.Stop[0]],
        Notification: []
      },
      statusLine: user.statusLine
    })
    const inline = run('claude', ['--settings={"env":{"A":"1"}}']).argv
    const merged = inline[0].slice('--settings='.length)
    expect(JSON.parse(readFileSync(merged, 'utf8'))).toEqual({ env: { A: '1' }, ...WITH_STATUS })
    expect(run('claude', ['--settings', '{"broken":']).argv).toEqual(['--settings', '{"broken":'])
    // The next merge collects the merged files whose launcher is gone.
    const last = run('claude', ['--settings', '{}']).argv[1]
    expect(readdirSync(hooksDir).filter((name) => name.startsWith('merged-'))).toEqual([
      last.slice(hooksDir.length + 1)
    ])
  })

  it('hands the settings over once through a wrapper script that runs `claude` again', () => {
    const wrapperDir = join(root, `wrapper-${Date.now()}`)
    mkdirSync(wrapperDir)
    writeFileSync(join(wrapperDir, 'claude'), '#!/bin/sh\nexec claude --wrapped "$@"\n')
    chmodSync(join(wrapperDir, 'claude'), 0o755)
    const result = spawnSync('claude', ['x'], {
      encoding: 'utf8',
      cwd: root,
      env: {
        PATH: [binDir, wrapperDir, realDir, '/usr/bin', '/bin'].join(':'),
        HOME: home,
        ORCA_PANE_KEY: 'tab-1:leaf'
      }
    })
    const argv = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('['))
      .map((line) => line.slice(1, -1))
    expect(argv).toEqual([
      '--wrapped',
      '--settings',
      join(hooksDir, 'claude-pod-settings-statusline.json'),
      'x'
    ])
    expect(existsSync(join(hooksDir, 'claude-pod-settings.json'))).toBe(true)
  })
})
