import { afterEach, describe, expect, it } from 'vitest'
import {
  POD_SANDBOX_VM_ENV_PREFIX,
  SANDBOX_FORWARDED_ENV,
  applyPodOrbstackTerminalOverride,
  setPodOrbstackTerminalResolver,
  setPodSandboxRelayStarter,
  withPodSandboxLaunchChoice
} from './pod-orbstack-terminal-override'

const ORB = '/Applications/OrbStack.app/Contents/MacOS/bin/orb'
const WORKTREE = 'repo::/Users/me/pod/acme/web'

function resolveFor(machine: string | null, dockerPinned = false): void {
  setPodOrbstackTerminalResolver((worktreeId) =>
    worktreeId === WORKTREE
      ? { orbPath: ORB, machine, dockerPinned, orbHome: null, sandbox: null }
      : null
  )
}

const plainRequest = { worktreeId: WORKTREE, connectionId: null }
// Why built: Pod's decouple codemod renames a standalone ORCA_ name, never one inside the VM name.
const VM_HOOK_TOKEN = `${POD_SANDBOX_VM_ENV_PREFIX}ORCA_AGENT_HOOK_TOKEN`

afterEach(() => setPodOrbstackTerminalResolver(null))

describe('applyPodOrbstackTerminalOverride', () => {
  it('turns a plain local shell into `orb -m <machine>`', () => {
    resolveFor('pod-web-1a2b3c4d')
    const options: {
      env: Record<string, string>
      shellOverride?: string
      terminalShellArgs?: string[]
    } = {
      env: {},
      shellOverride: '/bin/zsh',
      terminalShellArgs: ['-l']
    }
    applyPodOrbstackTerminalOverride(options, plainRequest, undefined)
    expect(options).toEqual({
      env: {},
      shellOverride: ORB,
      terminalShellArgs: ['-m', 'pod-web-1a2b3c4d']
    })
  })

  it.each([
    { name: 'agent launches', change: {}, command: 'claude' },
    { name: 'an explicit shell', change: { shellOverride: '/bin/bash' }, command: undefined },
    { name: 'SSH terminals', change: { connectionId: 'ssh-1' }, command: undefined },
    { name: 'other worktrees', change: { worktreeId: 'repo::/Users/me/other' }, command: undefined }
  ])('leaves $name alone', ({ change, command }) => {
    resolveFor('pod-web-1a2b3c4d', true)
    const options: { env: Record<string, string>; shellOverride?: string } = { env: {} }
    applyPodOrbstackTerminalOverride(options, { ...plainRequest, ...change }, command)
    expect(options.shellOverride).toBeUndefined()
  })

  it('pins DOCKER_CONTEXT for Mac terminals without replacing an explicit one', () => {
    resolveFor(null, true)
    const options: { env: Record<string, string>; shellOverride?: string } = { env: {} }
    applyPodOrbstackTerminalOverride(options, plainRequest, undefined)
    expect(options).toEqual({ env: { DOCKER_CONTEXT: 'orbstack' } })

    const explicit = { env: { DOCKER_CONTEXT: 'colima' } }
    applyPodOrbstackTerminalOverride(explicit, plainRequest, 'claude')
    expect(explicit.env.DOCKER_CONTEXT).toBe('colima')
  })

  it('is a no-op before Pod installs a resolver', () => {
    const options = { env: {} }
    applyPodOrbstackTerminalOverride(options, plainRequest, undefined)
    expect(options).toEqual({ env: {} })
  })
})

describe('sandboxed Claude launches', () => {
  const SANDBOX = 'pod-web-1a2b3c4d-sbx'

  function resolveSandbox(agentsByDefault: boolean): void {
    setPodOrbstackTerminalResolver((worktreeId) =>
      worktreeId === WORKTREE
        ? {
            orbPath: ORB,
            machine: null,
            dockerPinned: false,
            orbHome: null,
            sandbox: { machine: SANDBOX, agentsByDefault }
          }
        : null
    )
  }

  function claudeLaunch(extra: Record<string, string> = {}) {
    const env: Record<string, string> = { ORCA_PANE_KEY: 'tab:leaf', ...extra }
    return {
      env,
      cwd: '/Users/me/pod/acme/web',
      command: "claude --model 'opus'",
      launchAgent: 'claude'
    }
  }

  afterEach(() => setPodSandboxRelayStarter(null))

  it('wraps the launch in orb -m <sandbox>, forwarding only the hook routing env', () => {
    resolveSandbox(true)
    const options = claudeLaunch()
    applyPodOrbstackTerminalOverride(options, plainRequest, options.command)
    expect(options.command).toBe(
      `ORBENV=${SANDBOX_FORWARDED_ENV.join(':')} '${ORB}' '-m' '${SANDBOX}' '-w' '/Users/me/pod/acme/web' 'bash' '-lc' 'export DISABLE_AUTOUPDATER=1; exec claude --model '"'"'opus'"'"`
    )
    expect(options.command).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('gives the VM its own env under POD_SANDBOX_VM_ names, never the Mac shell', () => {
    resolveSandbox(true)
    const started: unknown[] = []
    setPodSandboxRelayStarter((machine, hookServer) => {
      started.push({ machine, hookServer })
      return {
        nonce: 'n0nce',
        vmEnv: {
          ORCA_AGENT_HOOK_TOKEN: 'sbx-token',
          NODE_EXTRA_CA_CERTS: '/etc/pod-sandbox/anthropic-ca.pem',
          ANTHROPIC_API_KEY: 'pod-sandbox-no-credential'
        }
      }
    })
    const options = claudeLaunch({
      ORCA_AGENT_HOOK_PORT: '41234',
      ORCA_AGENT_HOOK_TOKEN: 'server-token'
    })
    applyPodOrbstackTerminalOverride(options, plainRequest, options.command)
    expect(started).toEqual([
      { machine: SANDBOX, hookServer: { port: 41234, token: 'server-token' } }
    ])
    expect(options.env).toMatchObject({
      ORCA_AGENT_HOOK_TOKEN: 'server-token',
      [VM_HOOK_TOKEN]: 'sbx-token',
      POD_SANDBOX_VM_ANTHROPIC_API_KEY: 'pod-sandbox-no-credential'
    })
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
    const orbenv = options.command.split(' ')[0] ?? ''
    expect(orbenv).toContain(
      `:${VM_HOOK_TOKEN}:POD_SANDBOX_VM_NODE_EXTRA_CA_CERTS:POD_SANDBOX_VM_ANTHROPIC_API_KEY`
    )
    expect(orbenv).not.toContain(':ORCA_AGENT_HOOK_TOKEN')
    expect(options.command).not.toContain('server-token')
    expect(options.command).toContain(
      `'bash' '-lc' 'w=0; until [ "$(cat /run/pod-sandbox-relay/ready 2>/dev/null)" = n0nce ]`
    )
    expect(options.command).toContain(
      `done; export ORCA_AGENT_HOOK_TOKEN="$${VM_HOOK_TOKEN}"; unset ${VM_HOOK_TOKEN}; export NODE_EXTRA_CA_CERTS=`
    )
    expect(options.command).toContain(
      'unset POD_SANDBOX_VM_ANTHROPIC_API_KEY; export DISABLE_AUTOUPDATER=1; exec claude'
    )

    const codex = { ...claudeLaunch(), command: 'codex', launchAgent: 'codex' }
    applyPodOrbstackTerminalOverride(codex, plainRequest, codex.command)
    expect(codex.command).toBe('codex')
  })

  it('follows the per-launch marker over the worktree default', () => {
    resolveSandbox(false)
    const off = claudeLaunch()
    applyPodOrbstackTerminalOverride(off, plainRequest, off.command)
    expect(off.command).toBe("claude --model 'opus'")

    const on = claudeLaunch({ POD_ORBSTACK_SANDBOX: '1' })
    applyPodOrbstackTerminalOverride(on, plainRequest, on.command)
    expect(on.command).toContain(`'-m' '${SANDBOX}'`)

    resolveSandbox(true)
    const forcedOff = claudeLaunch({ POD_ORBSTACK_SANDBOX: '0' })
    applyPodOrbstackTerminalOverride(forcedOff, plainRequest, forcedOff.command)
    expect(forcedOff.command).toBe("claude --model 'opus'")
  })
})

describe('withPodSandboxLaunchChoice', () => {
  it("carries only the caller's sandbox choice onto the startup plan's env", () => {
    const plan = { CLAUDE_CODE_ENTRYPOINT: 'cli' }
    expect(withPodSandboxLaunchChoice(plan, { POD_ORBSTACK_SANDBOX: '1', OTHER: 'x' })).toEqual({
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      POD_ORBSTACK_SANDBOX: '1'
    })
    expect(withPodSandboxLaunchChoice(undefined, { POD_ORBSTACK_SANDBOX: '0' })).toEqual({
      POD_ORBSTACK_SANDBOX: '0'
    })
  })

  it('leaves the plan alone without a valid choice', () => {
    const plan = { A: '1' }
    expect(withPodSandboxLaunchChoice(plan, undefined)).toBe(plan)
    expect(withPodSandboxLaunchChoice(plan, { POD_ORBSTACK_SANDBOX: 'yes' })).toBe(plan)
    expect(withPodSandboxLaunchChoice(undefined, { OTHER: 'x' })).toBeUndefined()
  })
})
