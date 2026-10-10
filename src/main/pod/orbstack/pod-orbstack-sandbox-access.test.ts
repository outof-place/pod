import { afterEach, describe, expect, it } from 'vitest'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import type { SandboxRelayRoutes, SandboxRelays } from './pod-orbstack-relay'
import { createSandboxAccess } from './pod-orbstack-sandbox-access'

function fakeRelays() {
  const ensured: { machine: string; routes: SandboxRelayRoutes }[] = []
  const stopped: string[] = []
  const relays: SandboxRelays = {
    ensure: (machine, routes) => {
      ensured.push({ machine, routes })
      return { nonce: `nonce-${ensured.length}`, ready: Promise.resolve(true) }
    },
    stop: (machine) => stopped.push(machine),
    stopAll: () => undefined
  }
  return { relays, ensured, stopped }
}

const hookServer = { port: 41234, token: 'server-token' }

afterEach(() => setPodSandboxAnthropicCredentials(null))

describe('createSandboxAccess', () => {
  it('opens only the hook route while the credential source is the stub', () => {
    const { relays, ensured } = fakeRelays()
    const access = createSandboxAccess({ relays })
    const started = access.start('pod-a-sbx', hookServer)
    expect(Object.keys(started.vmEnv)).toEqual(['ORCA_AGENT_HOOK_TOKEN'])
    expect(started.vmEnv.ORCA_AGENT_HOOK_TOKEN).not.toBe('server-token')
    expect(ensured[0]?.routes.anthropic).toBeNull()
    expect(ensured[0]?.routes.hook.authorize(started.vmEnv.ORCA_AGENT_HOOK_TOKEN ?? '')).toBe(true)
    expect(ensured[0]?.routes.hook.authorize('server-token')).toBe(false)
  })

  it('adds the anthropic-api route and the placeholder for the credential kind', () => {
    const { relays, ensured } = fakeRelays()
    const access = createSandboxAccess({ relays })
    setPodSandboxAnthropicCredentials({ mode: () => 'api-key', authHeaders: async () => ({}) })
    expect(access.start('pod-a-sbx', hookServer).vmEnv).toMatchObject({
      NODE_EXTRA_CA_CERTS: '/etc/pod-sandbox/anthropic-ca.pem',
      ANTHROPIC_API_KEY: 'pod-sandbox-no-credential'
    })
    const caCert = ensured[0]?.routes.anthropic?.route.caCertPem
    expect(caCert).toContain('BEGIN CERTIFICATE')

    setPodSandboxAnthropicCredentials({ mode: () => 'oauth', authHeaders: async () => ({}) })
    const oauth = access.start('pod-a-sbx', hookServer).vmEnv
    expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toBe('pod-sandbox-no-credential')
    expect(oauth.ANTHROPIC_API_KEY).toBeUndefined()
    expect(ensured[1]?.routes.anthropic?.route.caCertPem).toBe(caCert)
  })

  it('drops the token, CA and route with the sandbox', () => {
    const { relays, ensured, stopped } = fakeRelays()
    const access = createSandboxAccess({ relays })
    setPodSandboxAnthropicCredentials({ mode: () => 'api-key', authHeaders: async () => ({}) })
    const first = access.start('pod-a-sbx', hookServer)
    access.forget('pod-a-sbx')
    expect(stopped).toEqual(['pod-a-sbx'])
    expect(ensured[0]?.routes.hook.authorize(first.vmEnv.ORCA_AGENT_HOOK_TOKEN ?? '')).toBe(false)
    access.start('pod-a-sbx', hookServer)
    expect(ensured[1]?.routes.anthropic?.route.caCertPem).not.toBe(
      ensured[0]?.routes.anthropic?.route.caCertPem
    )
  })
})
