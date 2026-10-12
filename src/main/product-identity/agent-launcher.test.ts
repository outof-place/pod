import { spawn, spawnSync } from 'node:child_process'
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
import { createServer } from 'node:net'
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
    // Why the cwd: the launcher looks for a statusLine from there up, and the checkout's parents
    // reach the real home.
    cwd: root,
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
    script(hooks, 'claude-statusline.sh', 'ps -o pri= -p $$')
    // The agent, a tool's shell and the command it runs (two levels down), a hook, the statusline.
    script(
      join(root, 'tree'),
      'claude',
      `echo $$; ps -o pri= -p $$; sh -c "sh -c \\"ps -o pri= -p \\\\$\\\\$\\""; ${join(hooks, 'claude-hook.sh')}; ${join(hooks, 'claude-statusline.sh')}`
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
    // The relay: the launcher only checks that something answers on its port.
    const relayServer = createServer((socket) => socket.end())
    let relayPort = 0
    beforeAll(async () => {
      await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve))
      const address = relayServer.address()
      relayPort = typeof address === 'object' && address !== null ? address.port : 0
    })
    afterAll(async () => {
      await new Promise((resolve) => relayServer.close(resolve))
    })

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
      writeFileSync(relay, `POD_HOOK_RELAY_PORT=${relayPort}\nPOD_HOOK_RELAY_TOKEN=tok\n`)
      writeFileSync(join(dir, 'endpoint.env'), 'ORCA_AGENT_HOOK_PORT=1\n')
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
        ORCA_AGENT_HOOK_ENDPOINT: join(dir, 'endpoint.env'),
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
      expect(settings.url).toBe(`http://127.0.0.1:${relayPort}/hook/claude`)
      expect(settings.token).toBe('tok')
      expect(Buffer.from(settings.pane, 'base64').toString()).toBe(
        `tab-1:leaf-1\x1ftab-1\x1f\x1frepo::/w\x1f\x1f\x1f${join(dir, 'endpoint.env')}`
      )
      expect(JSON.parse(settings.process)).toMatchObject({ pid: Number(pid), platform: 'darwin' })
      expect(lstatSync(launchFile).mode & 0o777).toBe(0o600)
      // A relay file a dead daemon left: the command template.
      const dead = join(dir, 'dead-relay.env')
      writeFileSync(dead, 'POD_HOOK_RELAY_PORT=1\nPOD_HOOK_RELAY_TOKEN=tok\n')
      expect(
        run('claude', ['x'], [binDir, join(dir, 'real')], {
          ...pane,
          POD_AGENT_HOOK_RELAY: dead
        }).stdout.split('\n')[0]
      ).toBe(`args=--settings ${join(dir, 'hooks', 'pod-claude-settings')}.command.json x`)
      // The relay reads only the endpoint file; without one the C client reads the pane's env.
      const noFile = { ...pane, POD_AGENT_HOOK_RELAY: relay, ORCA_AGENT_HOOK_ENDPOINT: '/nowhere' }
      expect(run('claude', ['x'], [binDir, join(dir, 'real')], noFile).stdout.split('\n')[0]).toBe(
        `args=--settings ${join(dir, 'hooks', 'pod-claude-settings')}.command.json x`
      )
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
      expect(
        run('claude', ['x'], real, { ...inPane, CLAUDE_JOB_DIR: '/j' }).stdout.split('\n')[0]
      ).toBe('args=x')
    })

    it('takes the statusLine template only while the user has no statusLine of their own', () => {
      const { dir, prefix, pane } = setup()
      writeFileSync(`${prefix}.command-statusline.json`, '{"hooks":{},"statusLine":{"x":1}}')
      const real = [binDir, join(dir, 'real')]
      expect(run('claude', ['x'], real, pane).stdout.split('\n')[0]).toBe(
        `args=--settings ${prefix}.command-statusline.json x`
      )
      const configDir = join(dir, 'config')
      mkdirSync(configDir)
      writeFileSync(join(configDir, 'settings.json'), '{"statusLine":{"command":"mine"}}')
      expect(
        run('claude', ['x'], real, { ...pane, CLAUDE_CONFIG_DIR: configDir }).stdout.split('\n')[0]
      ).toBe(`args=--settings ${prefix}.command.json x`)
    })

    it("merges the user's own --settings with Pod's, theirs first, and leaves Pod's own alone", () => {
      const { dir, prefix, pane } = setup()
      writeFileSync(
        `${prefix}.command.json`,
        '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"pod"}]}]},"statusLine":{"command":"pod"}}'
      )
      const real = [binDir, join(dir, 'real')]
      const mine = join(dir, 'mine.json')
      writeFileSync(
        mine,
        '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say"}]}]},"statusLine":{"command":"mine"}}'
      )
      const [argsLine, pidLine, merged] = run(
        'claude',
        ['--settings', mine, 'x'],
        real,
        pane
      ).stdout.split('\n')
      const pid = pidLine.replace('pid=', '')
      const mergedPath = join(dir, 'hooks', 'claude-launch', `merged-${pid}.json`)
      expect(argsLine).toBe(`args=--settings ${mergedPath} x`)
      expect(JSON.parse(merged)).toEqual({
        model: 'opus',
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'say' }] },
            { hooks: [{ type: 'command', command: 'pod' }] }
          ]
        },
        statusLine: { command: 'mine' }
      })
      expect(lstatSync(mergedPath).mode & 0o777).toBe(0o600)
      // Through the relay too: the filled template goes into the merged file only.
      writeFileSync(mine, '{"model":"opus"}')
      const relayed = run('claude', ['--settings', mine, 'x'], real, {
        ...pane,
        POD_AGENT_HOOK_RELAY: join(dir, 'relay.env')
      }).stdout.split('\n')
      const relayedPid = relayed[1].replace('pid=', '')
      expect(relayed[0]).toBe(
        `args=--settings ${join(dir, 'hooks', 'claude-launch', `merged-${relayedPid}.json`)} x`
      )
      expect(JSON.parse(relayed[2]).url).toBe(`http://127.0.0.1:${relayPort}/hook/claude`)
      expect(() =>
        lstatSync(join(dir, 'hooks', 'claude-launch', `claude-${relayedPid}.json`))
      ).toThrow()
      const inline = run('claude', ['--settings={"model":"opus"}', 'x'], real, pane).stdout
      expect(inline.split('\n')[0]).toMatch(/^args=--settings=\/.*\/merged-\d+\.json x$/)
      // A wrapper that runs claude again with Pod's file in its argv: left as it is.
      const again = ['--settings', `${prefix}.command.json`, 'x']
      expect(run('claude', again, real, pane).stdout.split('\n')[0]).toBe(`args=${again.join(' ')}`)
      // A user file Pod can't parse: Claude gets it as given, and reports the error itself.
      writeFileSync(mine, '{"model":')
      expect(run('claude', ['--settings', mine], real, pane).stdout.split('\n')[0]).toBe(
        `args=--settings ${mine}`
      )
    })
  })

  it('stops a wrapper that calls itself through PATH', () => {
    script(join(root, 'fork-wrapper'), 'claude', 'claude "$@"')
    const result = run('claude', [], [binDir, join(root, 'fork-wrapper')])
    expect(result.status).toBe(126)
    expect(result.stderr).toMatch(/wrapper scripts keep calling claude/)
  })
})
