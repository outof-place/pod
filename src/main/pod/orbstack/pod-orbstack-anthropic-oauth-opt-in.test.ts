import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  createClaudeOAuthSandboxCredentials,
  sandboxClaudeLoginAllowed
} from './pod-orbstack-anthropic-oauth'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import { OPEN_PRIVACY } from './pod-orbstack-privacy-env'
import type { SandboxRelayRoutes, SandboxRelays } from './pod-orbstack-relay'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createSandboxAccess } from './pod-orbstack-sandbox-access'

const root = mkdtempSync(join(tmpdir(), 'pod-oauth-opt-in-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => setPodSandboxAnthropicCredentials(null))

const hookServer = { port: 41234, token: 'server-token' }
const fakeLogin = JSON.stringify({
  claudeAiOauth: { accessToken: 'fake-oauth-token', expiresAt: Date.now() + 3_600_000 }
})

function setup(env: NodeJS.ProcessEnv = {}) {
  const registry = new PodOrbstackRegistry(join(mkdtempSync(join(root, 'r-')), 'registry.json'))
  const read = vi.fn(async () => fakeLogin)
  const source = createClaudeOAuthSandboxCredentials({
    allowed: () => sandboxClaudeLoginAllowed(registry, env),
    target: () => ({ account: 'system', configDir: null }),
    read
  })
  setPodSandboxAnthropicCredentials(source)
  const ensured: SandboxRelayRoutes[] = []
  const relays: SandboxRelays = {
    ensure: (_machine, routes) => {
      ensured.push(routes)
      return { nonce: `nonce-${ensured.length}`, ready: Promise.resolve(true) }
    },
    stop: () => undefined,
    stopAll: () => undefined
  }
  const access = createSandboxAccess({ relays, readPrivacy: () => OPEN_PRIVACY })
  return { registry, read, source, access, ensured }
}

describe("sandbox use of this Mac's Claude Code login", () => {
  it('stays closed by default: no route, no placeholder, no keychain read', async () => {
    const { source, access, ensured, read } = setup()
    expect(source.mode()).toBe('off')
    const { vmEnv } = access.start('pod-a-sbx', hookServer)
    expect(ensured[0]?.anthropic).toBeNull()
    expect(vmEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(vmEnv.NODE_EXTRA_CA_CERTS).toBeUndefined()
    await expect(source.authHeaders({ machine: 'pod-a-sbx' })).rejects.toThrow(
      /Settings > OrbStack/
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('takes effect without a restart in both directions', async () => {
    const { registry, source, access, ensured, read } = setup()
    registry.setSandboxClaudeLogin(true)
    const { vmEnv } = access.start('pod-a-sbx', hookServer)
    expect(ensured[0]?.anthropic).not.toBeNull()
    expect(vmEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('pod-sandbox-no-credential')
    expect(await source.authHeaders({ machine: 'pod-a-sbx' })).toEqual({
      authorization: 'Bearer fake-oauth-token'
    })
    // Turned off while the sandbox still runs: its next request is refused without a read.
    registry.setSandboxClaudeLogin(false)
    read.mockClear()
    await expect(source.authHeaders({ machine: 'pod-a-sbx' })).rejects.toThrow(
      /Settings > OrbStack/
    )
    expect(read).not.toHaveBeenCalled()
    expect(access.start('pod-a-sbx', hookServer).vmEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('stays off under POD_SANDBOX_ANTHROPIC=off even with the setting on', async () => {
    const { registry, source, read } = setup({ POD_SANDBOX_ANTHROPIC: 'off' })
    registry.setSandboxClaudeLogin(true)
    expect(source.mode()).toBe('off')
    await expect(source.authHeaders({ machine: 'pod-a-sbx' })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})
