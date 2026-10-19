// Fork-only (Pod): linear.getIssues reads many issues in one request, and a rate limit reaches the
// caller as linear_rate_limited {resetAt} from getIssues, getIssue and searchIssues alike.
import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { setSecretStore } from '../../../shared/secret-store'
import { turnLinearOnInFreshModules } from './pod-linear-access.test-support'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'
import {
  guardFetchToLoopback,
  LINEAR_MOCK_ORGANIZATION,
  linearMockIssueNode,
  linearMockIssuesReply,
  linearMockRateLimitedReply,
  startLinearMockServer,
  type LinearMockReply,
  type LinearMockRequest,
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const ORG = LINEAR_MOCK_ORGANIZATION.id
const RESET_AT = Date.UTC(2026, 9, 19, 6, 0, 0)
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

const UUID_9 = '9a1b2c3d-0000-4000-8000-000000000009'
const UUID_12 = '9a1b2c3d-0000-4000-8000-000000000012'
const issuesReply = linearMockIssuesReply([
  linearMockIssueNode(UUID_9, 'ENG-9'),
  linearMockIssueNode(UUID_12, 'ENG-12'),
  linearMockIssueNode('9a1b2c3d-0000-4000-8000-000000000101', 'OPS-1')
])

describe('Linear issue batch and rate limits', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null
  let reply: (request: LinearMockRequest) => LinearMockReply = issuesReply

  async function connected() {
    vi.resetModules()
    await turnLinearOnInFreshModules()
    const client = await import('../../linear/client')
    expect(await client.connect('mock-linear-key-1')).toMatchObject({ ok: true })
    return {
      batch: await import('./pod-linear-issue-batch'),
      lookups: await import('../../linear/linear-issue-lookups')
    }
  }

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const home = mkdtempSync(join(tmpdir(), 'pod-linear-home-'))
    const userData = mkdtempSync(join(tmpdir(), 'pod-linear-user-data-'))
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => home }
    })
    setTestUserData(userData)
    setSecretStore(fakeKeychain())
    reply = issuesReply
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

  it('reads many issues by UUID in one request, in the order asked, and names the missing', async () => {
    const { batch } = await connected()
    const before = server?.requests.length ?? 0
    const unknown = '9a1b2c3d-0000-4000-8000-000000000404'

    const result = await batch.getLinearIssuesByIds([UUID_12, unknown, UUID_9, UUID_12], ORG)

    expect(result.issues.map((issue) => issue.identifier)).toEqual(['ENG-12', 'ENG-9'])
    expect(result.issues[0]?.suggestedWorktreeName).toBe('eng-12-fix-eng-12')
    expect(result.missing).toEqual([unknown])
    const sent = server?.requests.slice(before) ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.variables).toEqual({
      filter: { or: [{ id: { in: [UUID_12, unknown, UUID_9] } }] },
      first: 3
    })
    expect(guard?.blocked).toEqual([])
  })

  it('reads identifiers by team key and number, mixed with UUIDs, still in one request', async () => {
    const { batch } = await connected()
    const before = server?.requests.length ?? 0

    const result = await batch.getLinearIssuesByIds(
      ['eng-12', UUID_9, 'OPS-1', 'ENG-9', 'ENG-404', 'not an id'],
      ORG
    )

    expect(result.issues.map((issue) => issue.identifier)).toEqual(['ENG-12', 'ENG-9', 'OPS-1'])
    expect(result.missing).toEqual(['ENG-404', 'not an id'])
    const sent = server?.requests.slice(before) ?? []
    expect(sent).toHaveLength(1)
    expect(sent[0]?.variables).toEqual({
      filter: {
        or: [
          { id: { in: [UUID_9] } },
          { team: { key: { eq: 'ENG' } }, number: { in: [12, 9, 404] } },
          { team: { key: { eq: 'OPS' } }, number: { in: [1] } }
        ]
      },
      first: 5
    })
  })

  it('finds nothing for an identifier sent as an id, as the mock models the API', async () => {
    const { batch } = await connected()
    reply = (request) =>
      issuesReply({
        ...request,
        variables: { filter: { or: [{ id: { in: ['ENG-9'] } }] } }
      })

    expect(await batch.getLinearIssuesByIds(['ENG-9'], ORG)).toEqual({
      issues: [],
      missing: ['ENG-9']
    })
  })

  it('types a rate limit for one workspace in getIssues, getIssue and searchIssues', async () => {
    const { batch, lookups } = await connected()
    reply = () => linearMockRateLimitedReply(RESET_AT)
    const limited = { code: 'linear_rate_limited', data: { resetAt: RESET_AT } }

    await expect(batch.getLinearIssuesByIds([UUID_9], ORG)).rejects.toMatchObject(limited)
    await expect(lookups.getIssue('issue-9', ORG)).rejects.toMatchObject(limited)
    await expect(lookups.searchIssues('login', 10, ORG)).rejects.toMatchObject(limited)
  })

  it('keeps "all" quiet, as upstream does, unless no workspace answered getIssues', async () => {
    const { batch, lookups } = await connected()
    reply = () => linearMockRateLimitedReply(RESET_AT)

    expect(await lookups.searchIssues('login', 10, 'all')).toEqual([])
    await expect(batch.getLinearIssuesByIds(['ENG-9'], 'all')).rejects.toMatchObject({
      code: 'linear_rate_limited'
    })
  })

  it('answers the RPC caller with the code and resetAt', async () => {
    await connected()
    reply = () => linearMockRateLimitedReply(RESET_AT)
    const { RpcDispatcher } = await import('../../runtime/rpc/dispatcher')
    const { POD_LINEAR_METHODS } = await import('./pod-linear-rpc-methods')
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: linear.getIssues reads no runtime member; the envelope needs only the id.
      runtime: { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService,
      methods: POD_LINEAR_METHODS
    })

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'linear.getIssues',
      params: { ids: ['ENG-9'], workspaceId: ORG }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'linear_rate_limited', data: { resetAt: RESET_AT } }
    })
  })
})
