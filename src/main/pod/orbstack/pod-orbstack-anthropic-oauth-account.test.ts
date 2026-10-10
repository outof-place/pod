import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as HttpModule from 'node:http'
import type * as Http2Module from 'node:http2'
import type * as HttpsModule from 'node:https'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Every way out of the process is a spy: the source must never reach a token endpoint, or anything.
const { keychainRead, network } = vi.hoisted(() => ({
  keychainRead: vi.fn<(configDir?: string) => Promise<string | null>>(),
  network: vi.fn()
}))
vi.mock('../../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: keychainRead
}))
vi.mock('node:https', async (original) => ({
  ...(await original<typeof HttpsModule>()),
  request: network,
  get: network
}))
vi.mock('node:http', async (original) => ({
  ...(await original<typeof HttpModule>()),
  request: network,
  get: network
}))
vi.mock('node:http2', async (original) => ({
  ...(await original<typeof Http2Module>()),
  connect: network
}))

import {
  createClaudeOAuthSandboxCredentials,
  readClaudeLoginItem,
  resolveMacClaudeLoginTarget,
  SandboxCredentialError
} from './pod-orbstack-anthropic-oauth'

const scope = { machine: 'pod-x-sbx' }
const profileHome = mkdtempSync(join(tmpdir(), 'pod-oauth-profile-'))
const item = (accessToken: string, expiresAt?: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'fake-refresh', expiresAt } })

afterAll(() => rmSync(profileHome, { recursive: true, force: true }))

beforeEach(() => {
  keychainRead.mockReset()
  network.mockReset()
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    network('fetch')
    return Promise.reject(new Error('no network in this test'))
  })
})

describe('sandbox OAuth account selection', () => {
  it('follows the account Pod routes Mac launches to', () => {
    expect(
      resolveMacClaudeLoginTarget({ router: { selectedHome: () => profileHome }, env: {} })
    ).toEqual({
      account: 'profile',
      configDir: profileHome
    })
  })

  it("uses the System default when no account is routed, honoring the user's own CLAUDE_CONFIG_DIR", () => {
    expect(resolveMacClaudeLoginTarget({ router: null, env: {} })).toEqual({
      account: 'system',
      configDir: null
    })
    expect(
      resolveMacClaudeLoginTarget({
        router: { selectedHome: () => null },
        env: { CLAUDE_CONFIG_DIR: '/u/claude' }
      })
    ).toEqual({ account: 'system', configDir: '/u/claude' })
    // Pod's own injected CLAUDE_CONFIG_DIR is not the user's default.
    expect(
      resolveMacClaudeLoginTarget({
        router: null,
        env: { CLAUDE_CONFIG_DIR: profileHome, ORCA_CLAUDE_INJECTED_CONFIG_DIR: profileHome }
      })
    ).toEqual({ account: 'system', configDir: null })
  })

  it('refuses like a Mac launch when the routed account folder is gone', () => {
    const missing = () => {
      throw new Error("The selected Claude account's folder is missing.")
    }
    expect(() =>
      resolveMacClaudeLoginTarget({ router: { selectedHome: missing }, env: {} })
    ).toThrow(SandboxCredentialError)
  })

  it("reads only the routed account's own item, never the System default's", async () => {
    keychainRead.mockImplementation(async (configDir) =>
      configDir === undefined ? item('fake-system-default-token') : null
    )
    expect(await readClaudeLoginItem({ account: 'profile', configDir: profileHome })).toBeNull()
    expect(keychainRead.mock.calls).toEqual([[profileHome]])
    // The account's own credentials file is its fallback, as for Claude Code itself.
    writeFileSync(join(profileHome, '.credentials.json'), item('fake-profile-file-token'))
    expect(await readClaudeLoginItem({ account: 'profile', configDir: profileHome })).toBe(
      readFileSync(join(profileHome, '.credentials.json'), 'utf8')
    )
    expect(keychainRead.mock.calls.every(([configDir]) => configDir === profileHome)).toBe(true)
  })

  it('switches with the routed account at once instead of serving the old one from memory', async () => {
    let home = '/profiles/a'
    const source = createClaudeOAuthSandboxCredentials({
      allowed: () => true,
      target: () => resolveMacClaudeLoginTarget({ router: { selectedHome: () => home }, env: {} }),
      read: async (target) => item(`fake-token-for-${target.configDir}`, Date.now() + 3_600_000)
    })
    expect(await source.authHeaders(scope)).toEqual({
      authorization: 'Bearer fake-token-for-/profiles/a'
    })
    home = '/profiles/b'
    expect(await source.authHeaders(scope)).toEqual({
      authorization: 'Bearer fake-token-for-/profiles/b'
    })
  })
})

describe('sandbox OAuth launch binding', () => {
  function routed(initial: string | null | Error) {
    let home: string | null | Error = initial
    const reads = vi.fn(async (target: { configDir: string | null }) =>
      item(`fake-token-for-${target.configDir ?? 'system'}`, Date.now() + 3_600_000)
    )
    const source = createClaudeOAuthSandboxCredentials({
      allowed: () => true,
      target: () =>
        resolveMacClaudeLoginTarget({
          router: {
            selectedHome: () => {
              if (home instanceof Error) {
                throw home
              }
              return home
            }
          },
          env: {}
        }),
      read: reads
    })
    return { source, reads, select: (next: string | null | Error) => (home = next) }
  }

  it('keeps a launched sandbox on the account its launch resolved, like a Mac pane', async () => {
    const { source, select } = routed('/profiles/a')
    source.launched({ machine: 'pod-a-sbx' })
    select('/profiles/b')
    expect(await source.authHeaders({ machine: 'pod-a-sbx' })).toEqual({
      authorization: 'Bearer fake-token-for-/profiles/a'
    })
    // A sandbox launched after the switch, or this one relaunched, gets the new account.
    source.launched({ machine: 'pod-b-sbx' })
    expect(await source.authHeaders({ machine: 'pod-b-sbx' })).toEqual({
      authorization: 'Bearer fake-token-for-/profiles/b'
    })
    source.launched({ machine: 'pod-a-sbx' })
    expect(await source.authHeaders({ machine: 'pod-a-sbx' })).toEqual({
      authorization: 'Bearer fake-token-for-/profiles/b'
    })
  })

  it('keeps refusing a sandbox launched while the routed account folder was missing', async () => {
    const { source, select } = routed(new Error("The selected Claude account's folder is missing."))
    source.launched({ machine: 'pod-a-sbx' })
    select('/profiles/b')
    await expect(source.authHeaders({ machine: 'pod-a-sbx' })).rejects.toThrow(
      "The selected Claude account's folder is missing."
    )
  })

  it('drops every token from memory once the last sandbox is gone', async () => {
    const { source, reads } = routed(null)
    source.launched({ machine: 'pod-a-sbx' })
    source.launched({ machine: 'pod-b-sbx' })
    await source.authHeaders({ machine: 'pod-a-sbx' })
    source.released({ machine: 'pod-a-sbx' })
    await source.authHeaders({ machine: 'pod-b-sbx' })
    expect(reads).toHaveBeenCalledTimes(1)
    source.released({ machine: 'pod-b-sbx' })
    source.launched({ machine: 'pod-c-sbx' })
    await source.authHeaders({ machine: 'pod-c-sbx' })
    expect(reads).toHaveBeenCalledTimes(2)
  })
})

describe('sandbox OAuth source footprint', () => {
  it('starts no timer and reads nothing while no sandbox request asks for a credential', async () => {
    vi.useFakeTimers()
    try {
      const reads = vi.fn(async () => item('fake-token', Date.now() + 3_600_000))
      const source = createClaudeOAuthSandboxCredentials({
        allowed: () => true,
        target: () => ({ account: 'system', configDir: null }),
        read: reads
      })
      vi.advanceTimersByTime(10 * 60_000)
      expect(reads).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await source.authHeaders(scope)
      vi.advanceTimersByTime(10 * 60_000)
      expect(reads).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never calls a token endpoint or any network, even for expired, refused or missing logins', async () => {
    keychainRead.mockResolvedValue(item('fake-expired-token', 1))
    const source = createClaudeOAuthSandboxCredentials({
      allowed: () => true,
      target: () => ({ account: 'system', configDir: null })
    })
    await expect(source.authHeaders(scope)).rejects.toThrow(SandboxCredentialError)
    source.rejected({ machine: 'pod-x-sbx' })
    keychainRead.mockResolvedValue(null)
    await expect(source.authHeaders(scope)).rejects.toThrow(SandboxCredentialError)
    expect(network).not.toHaveBeenCalled()
    // And the module has no way to: no fetch, no HTTP client, no refresh grant.
    const code = readFileSync(join(__dirname, 'pod-orbstack-anthropic-oauth.ts'), 'utf8')
    expect(code).not.toMatch(
      /\bfetch\(|node:https?|node:http2|refresh_token|refreshToken|oauth\/token/
    )
  })
})
