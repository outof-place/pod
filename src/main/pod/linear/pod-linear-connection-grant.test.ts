// Fork-only (Pod): agent access names the connections it was granted for. Every Connect seals a new
// random id with the key, so a reconnect, or a copy of an earlier grant, opens nothing for agents.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const KEY = 'mock-linear-key-1'
const OTHER_KEY = 'mock-linear-key-2'
const ROTATED_KEY = 'mock-linear-key-3'
const ORG = LINEAR_MOCK_ORGANIZATION.id
const OTHER = { ...LINEAR_MOCK_ORGANIZATION, id: 'org-mock-2', name: 'Other Co', urlKey: 'other' }
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

describe('agent access per connection', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null
  // Keys Linear no longer accepts; OTHER_KEY answers for OTHER, every other key for ORG.
  const revoked = new Set<string>()
  let storeDir = ''

  const keyPath = (orgId: string) =>
    join(storeDir, 'linear-tokens', `${Buffer.from(orgId).toString('base64url')}.enc`)
  const accessPath = () => join(storeDir, 'agent-access.enc')

  async function freshPod() {
    vi.resetModules()
    await turnLinearOnInFreshModules()
    const linear = await import('../../linear/client')
    const teams = await import('../../linear/teams')
    const access = await import('./pod-linear-access')
    const scope = await import('./pod-linear-call-scope')
    const keyStore = await import('./pod-linear-key-store')
    const { installPodLinear } = await import('./install-pod-linear')
    installPodLinear({ getSettings: () => ({ podLinear: true }), updateSettings: () => {} })
    const asAgent = <T>(run: () => T): T =>
      scope.runInPodLinearCallScope('linear.agentTeamList', run)
    const agentSees = () =>
      asAgent(() => linear.getClients('all').map((entry) => entry.workspace.id))
    const connectionId = (orgId: string): unknown => {
      const text = keyStore.readPodLinearKey(readFileSync(keyPath(orgId)))
      return text === null ? null : JSON.parse(text).connectionId
    }
    return { linear, teams, access, keyStore, asAgent, agentSees, connectionId }
  }

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const home = mkdtempSync(join(tmpdir(), 'pod-linear-home-'))
    const userData = mkdtempSync(join(tmpdir(), 'pod-linear-user-data-'))
    storeDir = join(userData, 'integrations', 'linear')
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => home }
    })
    setTestUserData(userData)
    setSecretStore(fakeKeychain())
    revoked.clear()
    server = await startLinearMockServer((request) => {
      if (revoked.has(request.authorization ?? '')) {
        return linearMockAuthErrorReply()
      }
      return request.authorization === OTHER_KEY && /\borganization\b/.test(request.query)
        ? { body: { data: { organization: OTHER } } }
        : defaultLinearMockReply(request)
    })
    process.env.POD_LINEAR_API_URL = server.apiUrl
    process.env.ORCA_E2E_USER_DATA_DIR = userData
    guard = guardFetchToLoopback()
  })

  afterEach(async () => {
    expect(guard?.blocked).toEqual([])
    guard?.restore()
    await server?.close()
    server = null
    restoreEnv('POD_LINEAR_API_URL', saved.apiUrl)
    restoreEnv('ORCA_E2E_USER_DATA_DIR', saved.profile)
    vi.doUnmock('os')
    vi.restoreAllMocks()
  })

  it('seals a new random id with the key on every Connect, also for the same key', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    const first = pod.connectionId(ORG)

    await pod.linear.connect(KEY)

    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(pod.connectionId(ORG)).toMatch(/^[0-9a-f]{32}$/)
    expect(pod.connectionId(ORG)).not.toBe(first)
    expect(readFileSync(keyPath(ORG), 'utf8')).not.toContain(String(first))
  })

  it('lets agents into the workspaces connected at the grant; a reconnect closes only that one', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    await pod.linear.connect(OTHER_KEY)
    expect(pod.access.writePodLinearAgentAccess(true)).toBe(true)
    expect(pod.agentSees()).toEqual([ORG, OTHER.id])

    await pod.linear.connect(KEY)

    expect(pod.agentSees()).toEqual([OTHER.id])
    expect(pod.asAgent(() => pod.linear.getClient(ORG))).toBeNull()
    expect(pod.asAgent(() => pod.linear.getStatus().workspaces?.map((w) => w.id))).toEqual([
      OTHER.id
    ])
    expect(pod.linear.getClients('all')).toHaveLength(2)
    expect(pod.access.isPodLinearAgentAccessOn()).toBe(true)
    expect((await freshPod()).agentSees()).toEqual([OTHER.id])

    await pod.linear.connect(OTHER_KEY)

    expect(pod.access.isPodLinearAgentAccessOn()).toBe(false)
    expect(pod.agentSees()).toEqual([])
  })

  it('keeps the id through a Test, a "needs a new key" mark and a switch; Disconnect drops it', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    await pod.linear.connect(OTHER_KEY)
    pod.access.writePodLinearAgentAccess(true)
    const id = pod.connectionId(ORG)

    expect(await pod.linear.testConnection(ORG)).toMatchObject({ ok: true })
    revoked.add(KEY)
    expect(await pod.linear.testConnection(ORG)).toMatchObject({ ok: false })
    revoked.delete(KEY)
    expect(await pod.linear.testConnection(ORG)).toMatchObject({ ok: true })
    pod.linear.selectWorkspace(ORG)
    pod.linear.selectWorkspace('all')

    expect(pod.connectionId(ORG)).toBe(id)
    expect(pod.agentSees()).toEqual([ORG, OTHER.id])
    const restarted = await freshPod()
    expect(restarted.agentSees()).toEqual([ORG, OTHER.id])

    restarted.linear.disconnect(ORG)

    expect(existsSync(keyPath(ORG))).toBe(false)
    expect(restarted.agentSees()).toEqual([OTHER.id])
  })

  it('reads a copy of a grant from before Disconnect and Connect as off', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    pod.access.writePodLinearAgentAccess(true)
    const grantCopy = readFileSync(accessPath())
    pod.access.writePodLinearAgentAccess(false)
    pod.linear.disconnect(ORG)
    await pod.linear.connect(KEY)

    writeFileSync(accessPath(), grantCopy)

    const restarted = await freshPod()
    expect(restarted.access.isPodLinearAgentAccessOn()).toBe(false)
    expect(restarted.agentSees()).toEqual([])
    expect(restarted.linear.getClients(ORG)).toHaveLength(1)
  })

  it('marks a restored old key and its grant "needs a new key" on Linear’s first 401', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    pod.access.writePodLinearAgentAccess(true)
    const backup = mkdtempSync(join(tmpdir(), 'pod-linear-store-copy-'))
    cpSync(storeDir, backup, { recursive: true })
    revoked.add(KEY)
    await pod.linear.connect(ROTATED_KEY)

    cpSync(backup, storeDir, { recursive: true, force: true })

    const restored = await freshPod()
    expect(restored.agentSees()).toEqual([ORG])
    const answer = await restored.asAgent(() => restored.teams.listTeamsForAgent(ORG))
    expect(answer).toMatchObject({ teams: [], errors: [{ workspaceId: ORG, type: 'auth' }] })
    expect(restored.linear.getStatus().workspaces?.[0]).toMatchObject({
      id: ORG,
      needsNewKey: true
    })
    expect(restored.agentSees()).toEqual([])
  })

  it('reads a key stored without an id as closed to agents', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    pod.access.writePodLinearAgentAccess(true)

    pod.keyStore.writePodLinearKey(keyPath(ORG), KEY)

    const restarted = await freshPod()
    expect(restarted.linear.getClients(ORG).map((entry) => entry.apiKey)).toEqual([KEY])
    expect(restarted.access.isPodLinearAgentAccessOn()).toBe(false)
    expect(restarted.agentSees()).toEqual([])
  })

  it('keeps agents out when the seal could be forged, though the key and the grant unseal', async () => {
    const pod = await freshPod()
    await pod.linear.connect(KEY)
    pod.access.writePodLinearAgentAccess(true)

    setSecretStore(fakeKeychain({ describeProtectionGap: () => 'built-in key' }))

    const weak = await freshPod()
    expect(weak.access.isPodLinearAgentAccessOn()).toBe(false)
    expect(weak.agentSees()).toEqual([])
  })
})
