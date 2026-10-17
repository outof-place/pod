import { request } from 'node:https'
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import type { SandboxRelayRoutes, SandboxRelays } from './pod-orbstack-relay'
import { OPEN_PRIVACY } from './pod-orbstack-privacy-env'
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
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
    const started = access.start('pod-a-sbx', hookServer)
    expect(Object.keys(started.vmEnv)).toEqual(['ORCA_AGENT_HOOK_TOKEN'])
    expect(started.vmEnv.ORCA_AGENT_HOOK_TOKEN).not.toBe('server-token')
    expect(ensured[0]?.routes.anthropic).toBeNull()
    expect(ensured[0]?.routes.hook.authorize(started.vmEnv.ORCA_AGENT_HOOK_TOKEN ?? '')).toBe(true)
    expect(ensured[0]?.routes.hook.authorize('server-token')).toBe(false)
  })

  it('adds the anthropic-api route and the placeholder for the credential kind', () => {
    const { relays, ensured } = fakeRelays()
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
    setPodSandboxAnthropicCredentials({ mode: () => 'api-key', authHeaders: async () => ({}) })
    expect(access.start('pod-a-sbx', hookServer).vmEnv).toMatchObject({
      NODE_EXTRA_CA_CERTS: '/etc/pod-sandbox/anthropic-ca.pem',
      ANTHROPIC_API_KEY: expect.stringMatching(/^pod-sandbox-no-credential-[0-9a-f]{32}$/)
    })
    const caCert = ensured[0]?.routes.anthropic?.route.caCertPem
    expect(caCert).toContain('BEGIN CERTIFICATE')

    setPodSandboxAnthropicCredentials({ mode: () => 'oauth', authHeaders: async () => ({}) })
    const oauth = access.start('pod-a-sbx', hookServer).vmEnv
    expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^pod-sandbox-no-credential-[0-9a-f]{32}$/)
    expect(oauth.ANTHROPIC_API_KEY).toBeUndefined()
    expect(ensured[1]?.routes.anthropic?.route.caCertPem).toBe(caCert)
  })

  it('gives each sandbox its own random placeholder, kept across launches, new after forget', () => {
    const { relays } = fakeRelays()
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
    setPodSandboxAnthropicCredentials({ mode: () => 'api-key', authHeaders: async () => ({}) })
    const a = access.start('pod-a-sbx', hookServer).vmEnv
    const b = access.start('pod-b-sbx', hookServer).vmEnv
    expect(a.ANTHROPIC_API_KEY).not.toBe(b.ANTHROPIC_API_KEY)
    expect(a.ORCA_AGENT_HOOK_TOKEN).not.toBe(b.ORCA_AGENT_HOOK_TOKEN)
    expect(access.start('pod-a-sbx', hookServer).vmEnv.ANTHROPIC_API_KEY).toBe(a.ANTHROPIC_API_KEY)
    access.forget('pod-a-sbx')
    const again = access.start('pod-a-sbx', hookServer).vmEnv
    expect(again.ANTHROPIC_API_KEY).not.toBe(a.ANTHROPIC_API_KEY)
    expect(again.ORCA_AGENT_HOOK_TOKEN).not.toBe(a.ORCA_AGENT_HOOK_TOKEN)
  })

  it('pre-starts the relay with the launch routes and binds no credential until a launch', () => {
    const { relays, ensured } = fakeRelays()
    const launched: string[] = []
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
    setPodSandboxAnthropicCredentials({
      mode: () => 'oauth',
      authHeaders: async () => ({}),
      launched: ({ machine }) => launched.push(machine)
    })
    access.prestart('pod-a-sbx', hookServer)
    expect(ensured).toHaveLength(1)
    expect(ensured[0]?.routes.hook).toMatchObject({ vmPort: 41234, hookToken: 'server-token' })
    expect(ensured[0]?.routes.anthropic?.route.caCertPem).toContain('BEGIN CERTIFICATE')
    expect(launched).toEqual([])
    // The launch asks for the same routes, so a real SandboxRelays keeps the pre-started relay.
    access.start('pod-a-sbx', hookServer)
    expect(ensured[1]?.routes.anthropic?.route.caCertPem).toBe(
      ensured[0]?.routes.anthropic?.route.caCertPem
    )
    expect(launched).toEqual(['pod-a-sbx'])
  })

  it('refuses API calls on a pre-started route until a launch mints the placeholder', async () => {
    const { relays, ensured } = fakeRelays()
    // A dead upstream (the discard port): nothing here may reach a real API.
    const access = createSandboxAccess({
      relays,
      readPrivacy: () => OPEN_PRIVACY,
      upstream: { host: '127.0.0.1', port: 9 }
    })
    setPodSandboxAnthropicCredentials({ mode: () => 'api-key', authHeaders: async () => ({}) })
    access.prestart('pod-a-sbx', hookServer)
    const route = ensured[0]?.routes.anthropic?.route
    expect(route).toBeDefined()
    const front = createServer((socket) => route?.attach(socket))
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    const call = (key: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: (front.address() as AddressInfo).port,
            servername: 'api.anthropic.com',
            ca: route?.caCertPem,
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': key, 'content-type': 'application/json' }
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end('{}')
      })
    try {
      // No launch yet: no placeholder exists, so any key, the placeholder's shape included, is refused.
      expect(await call('pod-sandbox-no-credential-0123456789abcdef0123456789abcdef')).toBe(401)
      const key = access.start('pod-a-sbx', hookServer).vmEnv.ANTHROPIC_API_KEY ?? ''
      // After the launch the minted placeholder passes Pod's check and goes on to the (dead) upstream.
      expect(await call(key)).not.toBe(401)
    } finally {
      front.close()
      access.forget('pod-a-sbx')
    }
  })

  it('binds the credential source to each launch and releases it with the sandbox', () => {
    const { relays } = fakeRelays()
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
    const events: string[] = []
    setPodSandboxAnthropicCredentials({
      mode: () => 'oauth',
      authHeaders: async () => ({}),
      launched: ({ machine }) => events.push(`launched ${machine}`),
      released: ({ machine }) => events.push(`released ${machine}`)
    })
    access.start('pod-a-sbx', hookServer)
    access.start('pod-a-sbx', hookServer)
    access.forget('pod-a-sbx')
    expect(events).toEqual(['launched pod-a-sbx', 'launched pod-a-sbx', 'released pod-a-sbx'])
  })

  it('mirrors the Mac privacy switches into the VM env', () => {
    const { relays } = fakeRelays()
    const access = createSandboxAccess({
      relays,
      readPrivacy: () => ({
        env: { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
        telemetryOff: true,
        featureFlagsOff: true
      })
    })
    expect(access.start('pod-a-sbx', hookServer).vmEnv).toMatchObject({
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1'
    })
  })

  it('adds no privacy switches the Mac does not set', () => {
    const { relays } = fakeRelays()
    const access = createSandboxAccess({
      relays,
      readPrivacy: () => ({ env: {}, telemetryOff: false, featureFlagsOff: false })
    })
    expect(Object.keys(access.start('pod-a-sbx', hookServer).vmEnv)).toEqual([
      'ORCA_AGENT_HOOK_TOKEN'
    ])
  })

  it('drops the token, CA and route with the sandbox', () => {
    const { relays, ensured, stopped } = fakeRelays()
    const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
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
