// Fork-only (Pod): when Linear rejects a key, Pod keeps it and marks the workspace "needs a new key"
// across a restart; a passing test or a new key clears the mark, and only Disconnect deletes the key.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../../shared/secret-store'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'
import { turnLinearOnInFreshModules } from './pod-linear-access.test-support'
import {
  defaultLinearMockReply,
  guardFetchToLoopback,
  LINEAR_MOCK_ORGANIZATION,
  linearMockAuthErrorReply,
  startLinearMockServer,
  type LinearMockReply,
  type LinearMockRequest,
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const KEY = 'mock-linear-key-1'
const NEW_KEY = 'mock-linear-key-2'
const ORG = LINEAR_MOCK_ORGANIZATION.id
const REJECTED = `Linear rejected the saved key for ${LINEAR_MOCK_ORGANIZATION.name}. Enter a new key.`
const saved = {
  apiUrl: process.env.POD_LINEAR_API_URL,
  profile: process.env.ORCA_E2E_USER_DATA_DIR
}

function restoreEnv(
  name: 'POD_LINEAR_API_URL' | 'ORCA_E2E_USER_DATA_DIR',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

/** Every file under dir with its bytes, recursively. */
function storeBytes(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory()
        ? Object.entries(storeBytes(path)).map(([file, bytes]) => [`${name}/${file}`, bytes])
        : [[name, readFileSync(path).toString('base64')]]
    })
  )
}

describe('a key Linear rejects', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null
  let reply: (request: LinearMockRequest) => LinearMockReply = defaultLinearMockReply
  let userData = ''
  let keyPath = ''

  async function freshClient() {
    vi.resetModules()
    await turnLinearOnInFreshModules()
    return import('../../linear/client')
  }

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const home = mkdtempSync(join(tmpdir(), 'pod-linear-home-'))
    userData = mkdtempSync(join(tmpdir(), 'pod-linear-user-data-'))
    keyPath = join(
      userData,
      'integrations',
      'linear',
      'linear-tokens',
      `${Buffer.from(ORG).toString('base64url')}.enc`
    )
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => home }
    })
    setTestUserData(userData)
    setSecretStore(fakeKeychain())
    reply = defaultLinearMockReply
    server = await startLinearMockServer((request) => reply(request))
    process.env.POD_LINEAR_API_URL = server.apiUrl
    process.env.ORCA_E2E_USER_DATA_DIR = userData
    guard = guardFetchToLoopback()
  })

  afterEach(async () => {
    guard?.restore()
    await server?.close()
    server = null
    restoreEnv('POD_LINEAR_API_URL', saved.apiUrl)
    restoreEnv('ORCA_E2E_USER_DATA_DIR', saved.profile)
    vi.doUnmock('os')
    vi.restoreAllMocks()
  })

  it('keeps the key, marks the workspace across a restart, and sends nothing more with it', async () => {
    let linear = await freshClient()
    expect(await linear.connect(KEY)).toMatchObject({ ok: true })
    const sealedKey = readFileSync(keyPath)
    reply = linearMockAuthErrorReply

    expect(await linear.testConnection(ORG)).toMatchObject({ ok: false })

    expect(readFileSync(keyPath)).toEqual(sealedKey)
    linear = await freshClient()
    expect(linear.getStatus()).toMatchObject({
      connected: true,
      credentialError: REJECTED,
      workspaces: [{ id: ORG, needsNewKey: true }]
    })
    const requestsBefore = server?.requests.length
    expect(linear.getClients(ORG)).toEqual([])
    expect(linear.getClient(ORG)).toBeNull()
    expect(server?.requests.length).toBe(requestsBefore)
    expect(guard?.blocked).toEqual([])
  })

  it('marks the key when listing teams gets a 401, for one workspace and for all', async () => {
    const linear = await freshClient()
    await linear.connect(KEY)
    const teams = await import('../../linear/teams')
    reply = linearMockAuthErrorReply

    await expect(teams.listTeams(ORG)).rejects.toThrow()
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({ id: ORG, needsNewKey: true })

    reply = defaultLinearMockReply
    expect(await linear.testConnection(ORG)).toMatchObject({ ok: true })
    reply = linearMockAuthErrorReply

    expect(await teams.listTeams('all')).toEqual([])
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({ id: ORG, needsNewKey: true })
  })

  it('clears the mark when a test passes with the kept key', async () => {
    const linear = await freshClient()
    await linear.connect(KEY)
    reply = linearMockAuthErrorReply
    await linear.testConnection(ORG)
    reply = defaultLinearMockReply

    expect(await linear.testConnection(ORG)).toMatchObject({ ok: true })

    const status = linear.getStatus()
    expect(status.credentialError).toBeUndefined()
    expect(status.workspaces?.[0]?.needsNewKey).toBeUndefined()
    expect(linear.getClients(ORG)).toHaveLength(1)
  })

  it('clears the mark on a new key, and Disconnect deletes the key and the mark', async () => {
    const linear = await freshClient()
    await linear.connect(KEY)
    reply = linearMockAuthErrorReply
    await linear.testConnection(ORG)
    reply = defaultLinearMockReply

    expect(await linear.connect(NEW_KEY)).toMatchObject({ ok: true })
    expect(linear.getStatus().workspaces?.[0]?.needsNewKey).toBeUndefined()
    expect(linear.getClients(ORG).map((entry) => entry.apiKey)).toEqual([NEW_KEY])

    reply = linearMockAuthErrorReply
    await linear.testConnection(ORG)
    linear.disconnect(ORG)

    expect(existsSync(keyPath)).toBe(false)
    expect(linear.getStatus()).toMatchObject({ connected: false })
    const rejections = JSON.parse(
      readFileSync(join(userData, 'integrations', 'linear', 'rejected-keys.json'), 'utf-8')
    )
    expect(rejections).toEqual({ version: 1, workspaceIds: [] })
  })

  it('marks only the workspace whose key was refused, and none without a workspace', async () => {
    const second = {
      ...LINEAR_MOCK_ORGANIZATION,
      id: 'org-mock-2',
      name: 'Other Co',
      urlKey: 'other'
    }
    const reachable = new Set([KEY, NEW_KEY])
    reply = (request) => {
      if (!reachable.has(request.authorization ?? '')) {
        return linearMockAuthErrorReply()
      }
      const answer = defaultLinearMockReply(request)
      return request.authorization === NEW_KEY && /\borganization\b/.test(request.query)
        ? { body: { data: { organization: second } } }
        : answer
    }
    const linear = await freshClient()
    await linear.connect(KEY)
    await linear.connect(NEW_KEY)
    reachable.delete(KEY)

    await linear.testConnection(ORG)

    expect(linear.getStatus().workspaces).toEqual([
      expect.objectContaining({ id: ORG, needsNewKey: true }),
      expect.not.objectContaining({ needsNewKey: true })
    ])
    const tokens = await import('../../linear/linear-token-store')
    tokens.clearToken()
    expect(linear.getStatus().workspaces?.[1]).not.toHaveProperty('needsNewKey')
  })

  it('tests a workspace without storing anything or moving the selection', async () => {
    const second = {
      ...LINEAR_MOCK_ORGANIZATION,
      id: 'org-mock-2',
      name: 'Other Co',
      urlKey: 'other'
    }
    reply = (request) =>
      request.authorization === NEW_KEY && /\borganization\b/.test(request.query)
        ? { body: { data: { organization: second } } }
        : defaultLinearMockReply(request)
    const linear = await freshClient()
    await linear.connect(KEY)
    await linear.connect(NEW_KEY)
    const storeDir = join(userData, 'integrations', 'linear')
    const before = storeBytes(storeDir)

    expect(await linear.testConnection(ORG)).toMatchObject({ ok: true, workspace: { id: ORG } })

    expect(linear.getStatus()).toMatchObject({
      selectedWorkspaceId: 'org-mock-2',
      activeWorkspaceId: 'org-mock-2'
    })
    expect(storeBytes(storeDir)).toEqual(before)
  })

  it('fails a Test whose key now answers for another organization, and keeps the mark', async () => {
    const other = {
      ...LINEAR_MOCK_ORGANIZATION,
      id: 'org-mock-9',
      name: 'Moved Co',
      urlKey: 'moved'
    }
    const linear = await freshClient()
    await linear.connect(KEY)
    reply = linearMockAuthErrorReply
    await linear.testConnection(ORG)
    reply = (request) =>
      /\borganization\b/.test(request.query)
        ? { body: { data: { organization: other } } }
        : defaultLinearMockReply(request)

    expect(await linear.testConnection(ORG)).toEqual({
      ok: false,
      error: 'This key now answers for Moved Co, not for the workspace it was saved for.'
    })
    expect(linear.getStatus().workspaces?.[0]).toMatchObject({ id: ORG, needsNewKey: true })
  })
})
