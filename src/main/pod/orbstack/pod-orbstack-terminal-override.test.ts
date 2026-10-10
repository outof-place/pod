import { afterEach, describe, expect, it } from 'vitest'
import {
  SANDBOX_FORWARDED_ENV,
  applyPodOrbstackTerminalOverride,
  setPodOrbstackTerminalResolver,
  setPodSandboxAgentEnvProvider
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

  afterEach(() => setPodSandboxAgentEnvProvider(null))

  it('wraps the launch in orb -m <sandbox>, forwarding only the hook routing env', () => {
    resolveSandbox(true)
    const options = claudeLaunch()
    applyPodOrbstackTerminalOverride(options, plainRequest, options.command)
    expect(options.command).toBe(
      `ORBENV=${SANDBOX_FORWARDED_ENV.join(':')} '${ORB}' '-m' '${SANDBOX}' '-w' '/Users/me/pod/acme/web' 'bash' '-lc' 'export DISABLE_AUTOUPDATER=1; exec claude --model '"'"'opus'"'"`
    )
    expect(options.command).not.toContain('CLAUDE_CONFIG_DIR')
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

  it('adds a host auth provider env to the forwarded keys without other agents changing', () => {
    resolveSandbox(true)
    setPodSandboxAgentEnvProvider(() => ({
      ANTHROPIC_BASE_URL: 'http://host.orb.internal:41001',
      ANTHROPIC_AUTH_TOKEN: 'per-launch'
    }))
    const options = claudeLaunch()
    applyPodOrbstackTerminalOverride(options, plainRequest, options.command)
    expect(options.env.ANTHROPIC_BASE_URL).toBe('http://host.orb.internal:41001')
    expect(options.command).toContain(':ANTHROPIC_BASE_URL:ANTHROPIC_AUTH_TOKEN ')

    const codex = { ...claudeLaunch(), command: 'codex', launchAgent: 'codex' }
    applyPodOrbstackTerminalOverride(codex, plainRequest, codex.command)
    expect(codex.command).toBe('codex')
  })
})
