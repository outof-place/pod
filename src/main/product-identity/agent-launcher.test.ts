import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const installer: unknown = require('../../../product/agent-launcher/install-agent-launcher.cjs')
const installAgentLauncher: unknown = Reflect.get(Object(installer), 'installAgentLauncher')
const agentCommands: unknown = Reflect.get(Object(installer), 'AGENT_COMMANDS')

let root = ''
let binDir = ''

function script(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function run(
  command: string,
  args: string[],
  pathDirs: string[],
  env: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), HOME: root, ...env }
  })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

describe.skipIf(process.platform !== 'darwin')('pod-agent-launcher', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-agent-launcher-'))
    binDir = join(root, 'Resources', 'bin')
    mkdirSync(binDir, { recursive: true })
    if (typeof installAgentLauncher !== 'function') {
      throw new Error('install-agent-launcher.cjs exports no installAgentLauncher')
    }
    installAgentLauncher(join(root, 'Resources'), process.arch)
    // The agent: prints its argv and its own scheduler priority after the launcher's exec.
    script(join(root, 'real'), 'claude', 'echo "args=$*"; ps -o pri= -p $$')
  }, 180_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('links every agent command to the launcher', () => {
    expect(agentCommands).toEqual(['claude', 'codex'])
    for (const command of ['claude', 'codex']) {
      expect(lstatSync(join(binDir, command)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(binDir, command))).toBe('pod-agent-launcher')
    }
  })

  it('runs the next command on PATH with its arguments, at app priority', () => {
    const turbo = run('claude', ['a', 'b c'], [binDir, join(root, 'real')])
    const plain = run('claude', ['a'], [binDir, join(root, 'real')], { POD_AGENT_TURBO: '0' })
    expect(turbo.status).toBe(0)
    expect(turbo.stdout.split('\n')[0]).toBe('args=a b c')
    expect(Number(turbo.stdout.split('\n')[1])).toBeGreaterThan(Number(plain.stdout.split('\n')[1]))
  })

  it('reports the task role it applied', () => {
    const turbo = run(join(binDir, 'pod-agent-launcher'), ['--print-policy'], [])
    const plain = run(join(binDir, 'pod-agent-launcher'), ['--print-policy'], [], {
      POD_AGENT_TURBO: '0'
    })
    expect(JSON.parse(turbo.stdout)).toMatchObject({ role: 7, turbo: true })
    expect(JSON.parse(plain.stdout)).toMatchObject({ role: 0, turbo: false })
  })

  it('keeps the exit status and fails like a shell when the command is missing', () => {
    expect(run(join(binDir, 'pod-agent-launcher'), ['--', 'sh', '-c', 'exit 42'], []).status).toBe(
      42
    )
    const missing = run('codex', [], [binDir])
    expect(missing.status).toBe(127)
    expect(missing.stderr).toBe('codex: command not found')
  })

  it('reaches the real command through a wrapper that execs it by name', () => {
    script(join(root, 'exec-wrapper'), 'claude', 'exec claude wrapped "$@"')
    const result = run('claude', ['x'], [binDir, join(root, 'exec-wrapper'), join(root, 'real')])
    expect(result.status).toBe(0)
    expect(result.stdout.split('\n')[0]).toBe('args=wrapped x')
  })

  it('stops a wrapper that calls itself through PATH', () => {
    script(join(root, 'fork-wrapper'), 'claude', 'claude "$@"')
    const result = run('claude', [], [binDir, join(root, 'fork-wrapper')])
    expect(result.status).toBe(126)
    expect(result.stderr).toMatch(/wrapper scripts keep calling claude/)
  })
})
