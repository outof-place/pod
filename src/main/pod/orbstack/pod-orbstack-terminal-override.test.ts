import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPodOrbstackTerminalOverride,
  setPodOrbstackTerminalResolver
} from './pod-orbstack-terminal-override'

const ORB = '/Applications/OrbStack.app/Contents/MacOS/bin/orb'
const WORKTREE = 'repo::/Users/me/pod/acme/web'

function resolveFor(machine: string | null, dockerPinned = false): void {
  setPodOrbstackTerminalResolver((worktreeId) =>
    worktreeId === WORKTREE ? { orbPath: ORB, machine, dockerPinned, orbHome: null } : null
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
