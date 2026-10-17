import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
      `echo $$; ps -o pri= -p $$; sleep 0.2; sh -c "sh -c \\"ps -o pri= -p \\\\$\\\\$\\""; ${join(hooks, 'claude-hook.sh')}; ${client}`
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

  it('stops a wrapper that calls itself through PATH', () => {
    script(join(root, 'fork-wrapper'), 'claude', 'claude "$@"')
    const result = run('claude', [], [binDir, join(root, 'fork-wrapper')])
    expect(result.status).toBe(126)
    expect(result.stderr).toMatch(/wrapper scripts keep calling claude/)
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
        stdout.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
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

    async function settled(): Promise<string[]> {
      // ogctl runs detached; give it a moment to write.
      await new Promise((resolve) => setTimeout(resolve, 400))
      return ogctlCalls()
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
      const env = launch('claude', { POD_INDEXED_SEARCH: '1', POD_TEST_SECRET: 'x', OG_CANARY_RATE: '0.5' })
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
