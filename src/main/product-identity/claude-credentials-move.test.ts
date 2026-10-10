import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listClaudeProfileIds,
  moveClaudeProfileCredentials,
  type ClaudeCredentialsKeychainPort
} from './claude-credentials-move'

const ACCOUNT = 'marcel'

function memoryKeychain(items: Record<string, string>, options: { denied?: string[] } = {}) {
  const store = new Map(Object.entries(items))
  const writes: { service: string; trusted: string | null }[] = []
  const keychain: ClaudeCredentialsKeychainPort = {
    hasItem: (service, account) => store.has(`${service}/${account}`),
    readSecret: (service, account) =>
      options.denied?.includes(service) ? null : (store.get(`${service}/${account}`) ?? null),
    writeSecret: (service, account, secret, trusted) => {
      store.set(`${service}/${account}`, secret)
      writes.push({ service, trusted })
    },
    deleteItem: (service, account) => store.delete(`${service}/${account}`)
  }
  return { keychain, store, writes }
}

const profile = (id: string) => ({
  id,
  legacyServices: [`legacy-${id}`, `legacy-${id}-alias`],
  productService: `product-${id}`
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('moveClaudeProfileCredentials', () => {
  it('moves each legacy sign-in to the product item and clears every legacy spelling', () => {
    const { keychain, store, writes } = memoryKeychain({
      [`legacy-a-alias/${ACCOUNT}`]: 'token-a',
      [`legacy-b/${ACCOUNT}`]: 'token-b',
      [`legacy-b-alias/${ACCOUNT}`]: 'token-b'
    })
    const result = moveClaudeProfileCredentials({
      profiles: [profile('a'), profile('b'), profile('c')],
      keychainAccount: ACCOUNT,
      trustedAppPath: '/Applications/Product.app',
      legacyAppPid: null,
      keychain
    })
    expect(result).toEqual({ status: 'moved', moved: ['a', 'b'], denied: [], legacyKept: [] })
    expect(Object.fromEntries(store)).toEqual({
      [`product-a/${ACCOUNT}`]: 'token-a',
      [`product-b/${ACCOUNT}`]: 'token-b'
    })
    expect(writes.every((write) => write.trusted === '/Applications/Product.app')).toBe(true)
  })

  it('waits while the legacy app runs, since it rotates these tokens', () => {
    const { keychain, store } = memoryKeychain({ [`legacy-a/${ACCOUNT}`]: 'token-a' })
    const result = moveClaudeProfileCredentials({
      profiles: [profile('a')],
      keychainAccount: ACCOUNT,
      trustedAppPath: null,
      legacyAppPid: 77,
      keychain
    })
    expect(result).toEqual({ status: 'deferred', reason: 'legacy-app-running', pid: 77 })
    expect(store.has(`product-a/${ACCOUNT}`)).toBe(false)
  })

  it('keeps a denied sign-in and never overwrites a product item', () => {
    const { keychain, store } = memoryKeychain(
      {
        [`legacy-a/${ACCOUNT}`]: 'old',
        [`product-a/${ACCOUNT}`]: 'current',
        [`legacy-b/${ACCOUNT}`]: 'token-b'
      },
      { denied: ['legacy-b'] }
    )
    const result = moveClaudeProfileCredentials({
      profiles: [profile('a'), profile('b')],
      keychainAccount: ACCOUNT,
      trustedAppPath: null,
      legacyAppPid: null,
      keychain
    })
    expect(result).toEqual({ status: 'moved', moved: [], denied: ['b'], legacyKept: [] })
    expect(store.get(`product-a/${ACCOUNT}`)).toBe('current')
    expect(store.get(`legacy-b/${ACCOUNT}`)).toBe('token-b')
  })

  it('lists profile folders and ignores anything else', () => {
    const userData = mkdtempSync(join(tmpdir(), 'claude-profiles-'))
    roots.push(userData)
    for (const name of ['9a103379-e825-411b-bc23-0b8c17acd203', '.DS_Store', 'bad name']) {
      mkdirSync(join(userData, 'claude-profiles', name), { recursive: true })
    }
    expect(listClaudeProfileIds(userData)).toEqual(['9a103379-e825-411b-bc23-0b8c17acd203'])
    expect(listClaudeProfileIds(join(userData, 'missing'))).toEqual([])
  })
})
