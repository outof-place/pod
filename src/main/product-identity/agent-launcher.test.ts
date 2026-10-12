import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

// Stand-in for Pod's statusline client: a binary, since a script's program is /bin/sh. It reports
// its own priority once the watcher has had time to react to its exec.
let statusLineClientPath = ''
function statusLineClient(dir: string): string {
  if (statusLineClientPath === join(dir, 'pod-agent-statusline')) {
    return statusLineClientPath
  }
  mkdirSync(dir, { recursive: true })
  const source = join(root, 'statusline-client.c')
  writeFileSync(
    source,
    '#include <stdio.h>\n#include <unistd.h>\nint main(void) { char pid[16]; usleep(100000); snprintf(pid, sizeof pid, "%d", getpid()); execl("/bin/ps", "ps", "-o", "pri=", "-p", pid, (char *)0); return 127; }\n'
  )
  const path = join(dir, 'pod-agent-statusline')
  const result = spawnSync('cc', ['-O2', '-o', path, source], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`cc: ${result.stderr}`)
  }
  statusLineClientPath = path
  return path
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
  'POD_SEARCH_UGREP',
  'POD_CLAUDE_EXECPATH',
  'OG_UGREP_FALLBACK',
  'USER_STARTUP'
]
// The probe names the ugrep it "embeds" the way Claude's binary does (NUL-delimited): 7.8.4, the
// checked one, unless built with -DOTHER_UGREP.
const PROBE_SOURCE = `#include <stdio.h>
#include <stdlib.h>
#ifdef OTHER_UGREP
__attribute__((used)) static const char ugrep_version[] = "x\\0ugrep 7.9.0\\0x";
#else
__attribute__((used)) static const char ugrep_version[] = "x\\0ugrep 7.8.4\\0x";
#endif
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
// Claude Code's snapshot `grep` defaults (2.1.295 to 2.1.302).
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
    // Why realpath: the launcher finds Resources from its own resolved path, and tmpdir() is
    // under /var, a link to /private/var. Why the space: the nested runtime's Resources sit
    // under "Pod Runtime.app".
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

  it("gives the agent's tools and hooks its priority, not Pod's statusline, and its watcher leaves with it", () => {
    const hooks = join(root, 'home', '.orca', 'agent-hooks')
    script(hooks, 'claude-hook.sh', 'ps -o pri= -p $$')
    const client = statusLineClient(hooks)
    // The agent, a tool's shell and the command it runs (two levels down), a hook, the statusline.
    // Why the sleep: the launcher no longer waits for the watcher, and the children here report
    // their priority in their first ms; one born before the follow gets the role from the sweep.
    script(
      join(root, 'tree'),
      'claude',
      `echo $$; ps -o pri= -p $$; sleep 0.2; sh -c "sh -c \\"ps -o pri= -p \\\\$\\\\$\\""; "${join(hooks, 'claude-hook.sh')}"; "${client}"`
    )
    const tree = run('claude', [], [binDir, join(root, 'tree')])
    const own = run('claude', [], [binDir, join(root, 'tree')], { POD_AGENT_TREE: '0' })
    const [agentPid, agent, command, hook, statusLine] = tree.stdout.split('\n').map(Number)
    expect(tree.status).toBe(0)
    expect(command).toBe(agent)
    expect(hook).toBe(agent)
    expect(statusLine).toBeLessThan(agent)
    const [, ownAgent, ownCommand] = own.stdout.split('\n').map(Number)
    expect(ownCommand).toBeLessThan(ownAgent)
    // The watcher follows the agent's exit (kqueue), a moment after it.
    const watching = (): boolean =>
      spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
        .stdout.split('\n')
        .some((line) => line.endsWith(`--tree-watch ${agentPid}`))
    const deadline = Date.now() + 2000
    while (watching() && Date.now() < deadline) {
      spawnSync('sleep', ['0.05'])
    }
    expect(watching()).toBe(false)
  })

  it("keeps Pod's statusline client at default by its program, through sh -c or directly, never by argv", () => {
    const hooks = join(root, 'home', '.orca', 'agent-hooks')
    const client = statusLineClient(hooks)
    script(hooks, 'pod-agent-hook', 'ps -o pri= -p $$')
    // As Pod's statusLine runs it (sh -c, then exec), with no shell in between, and the older
    // `pod-agent-hook statusline` form, which only argv would tell apart: it keeps the role.
    // `exec -a` pins "by program": the client under another argv[0] is the statusline, and another
    // program under the client's path as argv[0] is not.
    script(
      join(root, 'native'),
      'claude',
      `ps -o pri= -p $$; sleep 0.2; sh -c 'exec "${client}"'; "${client}"; sh -c 'exec "${join(hooks, 'pod-agent-hook')}" statusline'; /bin/bash -c 'exec -a status "${client}"'; /bin/bash -c 'exec -a "${client}" /bin/ps -o pri= -p $$'`
    )
    const result = run('claude', [], [binDir, join(root, 'native')])
    const [agent, viaShell, direct, byArgv, renamed, impostor] = result.stdout
      .split('\n')
      .map(Number)
    expect(result.status).toBe(0)
    expect(viaShell).toBeLessThan(agent)
    expect(direct).toBeLessThan(agent)
    expect(byArgv).toBe(agent)
    expect(renamed).toBeLessThan(agent)
    expect(impostor).toBe(agent)
  })

  it('takes the role back from a tool that has used a second of CPU', () => {
    // A busy loop and an idle process under the agent, read before and after the budget.
    script(
      join(root, 'busy'),
      'claude',
      [
        "sh -c 'while :; do :; done' &",
        'b=$!',
        "sh -c 'sleep 3' &",
        's=$!',
        'sleep 0.3',
        'echo "$(ps -o pri= -p $b) $(ps -o pri= -p $s)"',
        'sleep 2.4',
        'echo "$(ps -o pri= -p $b) $(ps -o pri= -p $s)"',
        'kill $b',
        'wait $s'
      ].join('\n')
    )
    const result = run('claude', [], [binDir, join(root, 'busy')])
    const [before, after] = result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
    expect(before[0]).toBe(before[1])
    expect(after[0]).toBeLessThan(after[1])
  }, 10_000)

  it('leaves no watcher behind when the agent or the launcher is killed', async () => {
    script(join(root, 'sleeper'), 'claude', 'exec sleep 30')
    const env = { PATH: [binDir, join(root, 'sleeper'), '/usr/bin', '/bin'].join(':'), HOME: root }
    const watchers = (pids: number[]): number =>
      spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((line) => pids.some((pid) => line.endsWith(`--tree-watch ${pid}`))).length
    const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
    const pids: number[] = []
    // A running agent killed outright, then a launcher killed while it starts.
    for (let i = 0; i < 5; i++) {
      const agent = spawn('claude', [], { env, stdio: 'ignore' })
      pids.push(agent.pid ?? 0)
      for (let tries = 0; tries < 50 && watchers([agent.pid ?? 0]) === 0; tries++) {
        await pause(20)
      }
      agent.kill('SIGKILL')
    }
    for (let i = 0; i < 3; i++) {
      const launcher = spawn('claude', [], { env, stdio: 'ignore' })
      pids.push(launcher.pid ?? 0)
      await pause(i)
      launcher.kill('SIGKILL')
    }
    await pause(1000)
    expect(watchers(pids)).toBe(0)
  }, 15_000)

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

  describe("Claude's hooks with the launch in a Pod pane", () => {
    function setup(): { dir: string; prefix: string; relay: string; pane: Record<string, string> } {
      const dir = mkdtempSync(join(root, 'settings-'))
      const prefix = join(dir, 'hooks', 'pod-claude-settings')
      mkdirSync(join(dir, 'hooks'))
      writeFileSync(
        `${prefix}.http.json`,
        '{"url":"@@POD_RELAY_URL@@","token":"@@POD_RELAY_TOKEN@@","pane":"@@POD_RELAY_PANE@@","process":"@@POD_AGENT_PROCESS@@"}'
      )
      writeFileSync(`${prefix}.command.json`, '{"hooks":{}}')
      const relay = join(dir, 'relay.env')
      writeFileSync(relay, 'POD_HOOK_RELAY_PORT=4567\nPOD_HOOK_RELAY_TOKEN=tok\n')
      // The agent: its argv, its pid (the launcher's after exec) and the settings file it got.
      script(
        join(dir, 'real'),
        'claude',
        'echo "args=$*"; echo "pid=$$"; [ "$1" = --settings ] && cat "$2"; exit 0'
      )
      script(join(dir, 'real'), 'codex', 'echo "args=$*"')
      const pane = {
        ORCA_PANE_KEY: 'tab-1:leaf-1',
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'repo::/w',
        ORCA_AGENT_HOOK_ENDPOINT: '/u/agent-hooks/endpoint.env',
        POD_CLAUDE_LAUNCH_SETTINGS: prefix
      }
      return { dir, prefix, relay, pane }
    }

    it("fills the http template for this claude: the relay, the pane and claude's own pid", () => {
      const { dir, relay, pane } = setup()
      const result = run('claude', ['-p', 'x'], [binDir, join(dir, 'real')], {
        ...pane,
        POD_AGENT_HOOK_RELAY: relay
      })
      const [argsLine, pidLine, settingsText] = result.stdout.split('\n')
      const pid = pidLine.replace('pid=', '')
      const launchFile = join(dir, 'hooks', 'claude-launch', `claude-${pid}.json`)
      expect(argsLine).toBe(`args=--settings ${launchFile} -p x`)
      const settings = JSON.parse(settingsText)
      expect(settings.url).toBe('http://127.0.0.1:4567/hook/claude')
      expect(settings.token).toBe('tok')
      expect(Buffer.from(settings.pane, 'base64').toString()).toBe(
        'tab-1:leaf-1\x1ftab-1\x1f\x1frepo::/w\x1f\x1f\x1f/u/agent-hooks/endpoint.env'
      )
      expect(JSON.parse(settings.process)).toMatchObject({ pid: Number(pid), platform: 'darwin' })
      expect(lstatSync(launchFile).mode & 0o777).toBe(0o600)
    })

    it('passes the command template without a relay, and drops files of claudes that are gone', () => {
      const { dir, prefix, pane } = setup()
      mkdirSync(join(dir, 'hooks', 'claude-launch'), { mode: 0o755 })
      const stale = join(dir, 'hooks', 'claude-launch', 'claude-999999.json')
      writeFileSync(stale, '{}')
      const result = run('claude', ['x'], [binDir, join(dir, 'real')], pane)
      expect(result.stdout.split('\n')[0]).toBe(`args=--settings ${prefix}.command.json x`)
      // A command-template launch writes no file and prunes nothing; an http one prunes.
      const relay = join(dir, 'relay.env')
      run('claude', ['x'], [binDir, join(dir, 'real')], { ...pane, POD_AGENT_HOOK_RELAY: relay })
      expect(() => lstatSync(stale)).toThrow()
      expect(lstatSync(join(dir, 'hooks', 'claude-launch')).mode & 0o777).toBe(0o700)
    })

    it("adds nothing outside a Pod pane, to other agents, or over the user's own --settings", () => {
      const { dir, pane, relay } = setup()
      const inPane = { ...pane, POD_AGENT_HOOK_RELAY: relay }
      const real = [binDir, join(dir, 'real')]
      expect(
        run('claude', ['x'], real, {
          POD_CLAUDE_LAUNCH_SETTINGS: pane.POD_CLAUDE_LAUNCH_SETTINGS
        }).stdout.split('\n')[0]
      ).toBe('args=x')
      expect(run('codex', ['x'], real, inPane).stdout).toBe('args=x')
      expect(run('claude', ['--settings', 'mine.json'], real, inPane).stdout.split('\n')[0]).toBe(
        'args=--settings mine.json'
      )
      expect(
        run('claude', ['x'], real, { ...inPane, CLAUDE_JOB_DIR: '/j' }).stdout.split('\n')[0]
      ).toBe('args=x')
    })
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
    const bundledEntry = (): string => join(root, 'Resources', 'pod-search', 'ugrep-shim', 'ugrep')
    const userZdot = (): string => join(root, 'user zdot')
    const userBashEnv = (): string => join(root, 'user-bashenv')
    let agentEnv: Record<string, string> = {}

    beforeAll(() => {
      mkdirSync(versions(), { recursive: true })
      const probe = join(versions(), '2.1.296')
      for (const [out, flags] of [
        [probe, []],
        [join(versions(), '2.1.999'), ['-DOTHER_UGREP']]
      ] as const) {
        const compiled = spawnSync('xcrun', ['clang', '-O2', ...flags, '-x', 'c', '-', '-o', out], {
          input: PROBE_SOURCE,
          encoding: 'utf8'
        })
        if (compiled.status !== 0) {
          throw new Error(compiled.stderr)
        }
      }
      mkdirSync(join(root, 'og'), { recursive: true })
      copyFileSync(probe, entry())
      chmodSync(entry(), 0o755)
      // The launcher hands og only over the bundled entry (indexed search installed).
      mkdirSync(join(bundledEntry(), '..'), { recursive: true })
      copyFileSync(probe, bundledEntry())
      chmodSync(bundledEntry(), 0o755)
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
        POD_SEARCH_UGREP: bundledEntry(),
        POD_CLAUDE_OG_VERSION: '2.1.296'
      })
    })

    it('runs a build that embeds another ugrep as if the flag were off', () => {
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
        POD_SEARCH_UGREP: entry(),
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

  describe('POD_INDEXED_SEARCH', () => {
    const searchDir = (): string => join(root, 'Resources', 'pod-search')
    const shim = (): string => join(searchDir(), 'rg-shim')
    const agentDir = (): string => join(root, 'search-real')
    const ogctlLog = (): string => join(root, 'ogctl.log')
    const report =
      'echo "PATH=$PATH"; echo "OG_REAL_RG=$OG_REAL_RG"; echo "POD_SEARCH_SPAWN=$POD_SEARCH_SPAWN"; ' +
      'echo "OG_CANARY_RATE=$OG_CANARY_RATE"; echo "OG_CANARY_KILL_FILE=$OG_CANARY_KILL_FILE"'

    beforeAll(() => {
      mkdirSync(join(searchDir(), 'bin'), { recursive: true })
      for (const name of ['og', 'ogd', 'rg']) {
        script(join(searchDir(), 'bin'), name, 'exit 0')
      }
      // ogctl stand-in: what it was asked and which environment reached it.
      script(
        join(searchDir(), 'bin'),
        'ogctl',
        `echo "$*|HOME=$HOME|SPAWN=$POD_SEARCH_SPAWN|SECRET=\${POD_TEST_SECRET-unset}" >> '${ogctlLog()}'`
      )
      mkdirSync(shim(), { recursive: true })
      symlinkSync('../bin/og', join(shim(), 'rg'))
      script(agentDir(), 'claude', report)
      script(agentDir(), 'codex', report)
    })

    function agentEnv(stdout: string): Record<string, string> {
      return Object.fromEntries(
        stdout
          .split('\n')
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
      )
    }

    function launch(
      command: string,
      env: Record<string, string>,
      cwd: string = process.cwd()
    ): Record<string, string> {
      const result = spawnSync(command, [], {
        encoding: 'utf8',
        cwd,
        env: { PATH: [binDir, agentDir(), '/usr/bin', '/bin'].join(':'), HOME: root, ...env }
      })
      expect(result.status).toBe(0)
      return agentEnv(result.stdout.trim())
    }

    function ogctlCalls(): string[] {
      return existsSync(ogctlLog()) ? readFileSync(ogctlLog(), 'utf8').trim().split('\n') : []
    }

    /** The ogctl calls once a sentinel launch (in a folder of its own) has been logged: ogctl
     *  runs detached, and anything an earlier launch started is in by then. */
    async function settled(): Promise<string[]> {
      const sentinel = join(root, 'sentinel')
      mkdirSync(sentinel, { recursive: true })
      launch('claude', { POD_INDEXED_SEARCH: '1' }, sentinel)
      const line = `ensure --register ${realpathSync(sentinel)}|`
      for (let i = 0; i < 100 && !ogctlCalls().some((call) => call.startsWith(line)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const calls = ogctlCalls()
      expect(calls.filter((call) => call.startsWith(line))).toHaveLength(1)
      return calls.filter((call) => !call.startsWith(line))
    }

    it('leaves the environment alone while the setting is off', async () => {
      rmSync(ogctlLog(), { force: true })
      const env = launch('claude', {})
      expect(env.PATH.split(':')).not.toContain(shim())
      expect(env.OG_REAL_RG).toBe('')
      expect(await settled()).toEqual([])
    })

    it("gives Claude's Bash og as its rg, turns the canary off and indexes the folder", async () => {
      rmSync(ogctlLog(), { force: true })
      const env = launch('claude', {
        POD_INDEXED_SEARCH: '1',
        POD_TEST_SECRET: 'x',
        OG_CANARY_RATE: '0.5'
      })
      expect(env.PATH.split(':')[0]).toBe(shim())
      expect(env.OG_REAL_RG).toBe(join(searchDir(), 'bin', 'rg'))
      expect(env.POD_SEARCH_SPAWN).toBe('1')
      expect(env.OG_CANARY_RATE).toBe('0')
      expect(env.OG_CANARY_KILL_FILE).toBe(
        join(root, 'Library', 'Caches', 'codes.pod.agent-launcher', 'og-canary-off')
      )
      // ogctl gets only what the daemon needs: no token of the agent's reaches it.
      expect(await settled()).toEqual([
        `ensure --register ${realpathSync(process.cwd())}|HOME=${root}|SPAWN=1|SECRET=unset`
      ])
    })

    it('puts rg-shim on PATH once for a claude started under claude', () => {
      const path = [shim(), binDir, agentDir(), '/usr/bin', '/bin'].join(':')
      const env = launch('claude', { POD_INDEXED_SEARCH: '1', PATH: path })
      expect(env.PATH.split(':').filter((dir) => dir === shim())).toHaveLength(1)
    })

    it('leaves other agents and a Pod without the payload alone', () => {
      expect(launch('codex', { POD_INDEXED_SEARCH: '1' }).PATH.split(':')).not.toContain(shim())
      chmodSync(join(searchDir(), 'bin', 'og'), 0o644)
      try {
        expect(launch('claude', { POD_INDEXED_SEARCH: '1' }).PATH.split(':')).not.toContain(shim())
      } finally {
        chmodSync(join(searchDir(), 'bin', 'og'), 0o755)
      }
    })

    it('starts no indexing in the home directory', async () => {
      rmSync(ogctlLog(), { force: true })
      const env = launch('claude', { POD_INDEXED_SEARCH: '1' }, root)
      expect(env.PATH.split(':')[0]).toBe(shim())
      expect(await settled()).toEqual([])
    })
  })
})
