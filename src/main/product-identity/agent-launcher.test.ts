import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

// A native stand-in for Claude's binary and for og's ugrep entry: prints its argv and the
// agent-shell environment (a script would lose the argv[0] Claude's binary dispatches on).
const PROBE_ENV = [
  'ZDOTDIR',
  'POD_ORIG_ZDOTDIR',
  'BASH_ENV',
  'POD_ORIG_BASH_ENV',
  'POD_SEARCH_TOOL',
  'POD_CLAUDE_OG_VERSION',
  'POD_CLAUDE_EXECPATH',
  'OG_UGREP_FALLBACK',
  'USER_STARTUP'
]
const PROBE_SOURCE = `#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  static const char *names[] = {${PROBE_ENV.map((name) => `"${name}"`).join(', ')}};
  printf("argv0=%s\\n", argv[0]);
  for (int i = 1; i < argc; i++) printf("arg=%s\\n", argv[i]);
  for (unsigned i = 0; i < sizeof names / sizeof *names; i++) {
    const char *value = getenv(names[i]);
    if (value != NULL) printf("%s=%s\\n", names[i], value);
  }
  return 0;
}
`
// Claude Code 2.1.296's snapshot `grep` defaults.
const UGREP_DEFAULTS = [
  '-G',
  '--ignore-files',
  '--hidden',
  '-I',
  ...['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'].map((dir) => `--exclude-dir=${dir}`)
]

type Probe = { argv0: string; args: string[]; env: Record<string, string> }

function probeOutput(stdout: string): Probe {
  const probe: Probe = { argv0: '', args: [], env: {} }
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'argv0') {
      probe.argv0 = value
    } else if (key === 'arg') {
      probe.args.push(value)
    } else if (eq > 0) {
      probe.env[key] = value
    }
  }
  return probe
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
    // Why the space: the nested runtime's Resources sit under "Pod Runtime.app".
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pod agent-launcher-')))
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

  describe('POD_CLAUDE_OG', () => {
    const shellDir = (): string => join(root, 'Resources', 'agent-shell')
    const versions = (): string => join(root, 'claude', 'versions')
    const claudeBin = (): string => join(root, 'claude', 'bin')
    const otherBin = (): string => join(root, 'claude', 'other-bin')
    const entry = (): string => join(root, 'og', 'ugrep')
    const userZdot = (): string => join(root, 'user zdot')
    const userBashEnv = (): string => join(root, 'user-bashenv')
    let agentEnv: Record<string, string> = {}

    beforeAll(() => {
      mkdirSync(versions(), { recursive: true })
      const probe = join(versions(), '2.1.296')
      const compiled = spawnSync('xcrun', ['clang', '-O2', '-x', 'c', '-', '-o', probe], {
        input: PROBE_SOURCE,
        encoding: 'utf8'
      })
      if (compiled.status !== 0) {
        throw new Error(compiled.stderr)
      }
      copyFileSync(probe, join(versions(), '2.1.999'))
      chmodSync(join(versions(), '2.1.999'), 0o755)
      mkdirSync(join(root, 'og'), { recursive: true })
      copyFileSync(probe, entry())
      chmodSync(entry(), 0o755)
      mkdirSync(claudeBin(), { recursive: true })
      symlinkSync(join('..', 'versions', '2.1.296'), join(claudeBin(), 'claude'))
      mkdirSync(otherBin(), { recursive: true })
      symlinkSync(join('..', 'versions', '2.1.999'), join(otherBin(), 'claude'))
      mkdirSync(userZdot(), { recursive: true })
      writeFileSync(join(userZdot(), '.zshenv'), 'export USER_STARTUP="zshenv:$ZDOTDIR"\n')
      writeFileSync(userBashEnv(), 'export USER_STARTUP="bashenv:$BASH_ENV"\n')
      const launched = run('claude', [], [binDir, claudeBin()], {
        POD_CLAUDE_OG: '1',
        ZDOTDIR: userZdot()
      })
      agentEnv = probeOutput(launched.stdout).env
    }, 60_000)

    function claudeShell(shell: string, command: string, env: Record<string, string> = {}): Probe {
      const result = run(shell, ['-c', command], [binDir], {
        ...agentEnv,
        CLAUDE_CODE_EXECPATH: join(versions(), '2.1.296'),
        POD_SEARCH_UGREP: entry(),
        ...env
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      return probeOutput(result.stdout)
    }
    const zshGrep = (args: string[]): string =>
      `ARGV0=ugrep "$CLAUDE_CODE_EXECPATH" ${[...UGREP_DEFAULTS, ...args].join(' ')}`

    it('leaves claude alone unless the flag is on', () => {
      const off = probeOutput(
        run('claude', ['a'], [binDir, claudeBin()], { ZDOTDIR: userZdot() }).stdout
      )
      expect(off).toEqual({ argv0: 'claude', args: ['a'], env: { ZDOTDIR: userZdot() } })
    })

    it('gives a checked Claude build the agent shell and keeps the user value', () => {
      expect(agentEnv).toEqual({
        ZDOTDIR: join(shellDir(), 'zsh'),
        POD_ORIG_ZDOTDIR: userZdot(),
        BASH_ENV: join(shellDir(), 'bash', 'bashenv'),
        POD_SEARCH_TOOL: join(shellDir(), 'pod-search-tool'),
        POD_CLAUDE_OG_VERSION: '2.1.296'
      })
    })

    it('runs any other Claude build as if the flag were off', () => {
      const other = run('claude', [], [binDir, otherBin()], { POD_CLAUDE_OG: '1' })
      expect(probeOutput(other.stdout).env).toEqual({})
    })

    it("sends the snapshot grep to og's ugrep entry and hands the user's startup back", () => {
      const probe = claudeShell('/bin/zsh', zshGrep(['-rl', 'needle', '.']))
      expect(probe.argv0).toBe('ugrep')
      expect(probe.args).toEqual([...UGREP_DEFAULTS, '-rl', 'needle', '.'])
      expect(probe.env).toEqual({
        ZDOTDIR: userZdot(),
        POD_SEARCH_TOOL: join(shellDir(), 'pod-search-tool'),
        POD_CLAUDE_OG_VERSION: '2.1.296',
        POD_CLAUDE_EXECPATH: join(versions(), '2.1.296'),
        OG_UGREP_FALLBACK: join(versions(), '2.1.296'),
        USER_STARTUP: `zshenv:${userZdot()}`
      })
    })

    it('does the same through bash', () => {
      const probe = claudeShell(
        '/bin/bash',
        `(exec -a ugrep "$CLAUDE_CODE_EXECPATH" ${UGREP_DEFAULTS.join(' ')} -rn needle src)`,
        // SHLVL: claude runs under the pane's shell; a top-level bash on a socket skips BASH_ENV.
        { BASH_ENV: agentEnv.BASH_ENV, POD_ORIG_BASH_ENV: userBashEnv(), SHLVL: '1' }
      )
      expect(probe.argv0).toBe('ugrep')
      expect(probe.args).toEqual([...UGREP_DEFAULTS, '-rn', 'needle', 'src'])
      expect(probe.env.OG_UGREP_FALLBACK).toBe(join(versions(), '2.1.296'))
      expect(probe.env.USER_STARTUP).toBe(`bashenv:${userBashEnv()}`)
      expect(probe.env.ZDOTDIR).toBe(userZdot())
    })

    it("gives everything else to Claude's binary with the same argv", () => {
      const real = join(versions(), '2.1.296')
      const noEntry = claudeShell('/bin/zsh', zshGrep(['-c', 'x']), { POD_SEARCH_UGREP: '' })
      expect(noEntry.argv0).toBe('ugrep')
      expect(noEntry.args).toEqual([...UGREP_DEFAULTS, '-c', 'x'])
      expect(noEntry.env.POD_CLAUDE_EXECPATH).toBe(real)
      expect(noEntry.env.OG_UGREP_FALLBACK).toBeUndefined()
      const find = claudeShell('/bin/zsh', 'ARGV0=bfs "$CLAUDE_CODE_EXECPATH" -S dfs . -name x')
      expect([find.argv0, ...find.args]).toEqual(['bfs', '-S', 'dfs', '.', '-name', 'x'])
      expect(find.env.OG_UGREP_FALLBACK).toBeUndefined()
      const changed = UGREP_DEFAULTS.filter((arg) => arg !== '--hidden')
      const drift = claudeShell(
        '/bin/zsh',
        `ARGV0=ugrep "$CLAUDE_CODE_EXECPATH" ${changed.join(' ')} -rl x .`
      )
      expect(drift.args).toEqual([...changed, '-rl', 'x', '.'])
      expect(drift.env.OG_UGREP_FALLBACK).toBeUndefined()
    })

    it('keeps the variable of a Claude build the launcher did not check', () => {
      const other = claudeShell('/bin/zsh', zshGrep(['-rl', 'x', '.']), {
        CLAUDE_CODE_EXECPATH: join(versions(), '2.1.999')
      })
      expect(other.argv0).toBe('ugrep')
      expect(other.env.POD_CLAUDE_EXECPATH).toBeUndefined()
      expect(other.env.OG_UGREP_FALLBACK).toBeUndefined()
    })
  })
})
