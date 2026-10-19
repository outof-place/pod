// Fork-only (Pod): with POD_LINEAR_API_URL, the real @linear/sdk talks to the mock server on
// loopback and nowhere else; a refused value fails the connect without a single request.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  guardFetchToLoopback,
  LINEAR_MOCK_ORGANIZATION,
  LINEAR_MOCK_VIEWER,
  startLinearMockServer,
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const FAKE_KEY = 'lin_api_fake_0000000000000000000000000000'
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

describe('Linear on the mock server', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.ORCA_E2E_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pod-linear-profile-'))
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

  it('sends the SDK’s queries to the mock, with the key as the Authorization header', async () => {
    server = await startLinearMockServer()
    process.env.POD_LINEAR_API_URL = server.apiUrl
    const { loadLinearSdk } = await import('../../linear/linear-sdk')
    const client = new (loadLinearSdk().LinearClient)({ apiKey: FAKE_KEY })

    const viewer = await client.viewer
    const organization = await viewer.organization

    expect(viewer.name).toBe(LINEAR_MOCK_VIEWER.name)
    expect(organization.urlKey).toBe(LINEAR_MOCK_ORGANIZATION.urlKey)
    expect(server.requests.length).toBeGreaterThanOrEqual(2)
    expect(server.requests.every((request) => request.authorization === FAKE_KEY)).toBe(true)
    expect(guard?.blocked).toEqual([])
  })

  it('fails the connect on a host off loopback, with no request sent anywhere', async () => {
    process.env.POD_LINEAR_API_URL = 'https://api.linear.app/graphql'
    const tempHome = mkdtempSync(join(tmpdir(), 'pod-linear-home-'))
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => tempHome }
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { connect } = await import('../../linear/client')

    const result = await connect(FAKE_KEY)

    expect(result).toEqual({ ok: false, error: expect.stringContaining('Linear is off') })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(guard?.blocked).toEqual([])
  })

  it('fails a client in a profile that is not isolated, even for a loopback mock', async () => {
    server = await startLinearMockServer()
    process.env.POD_LINEAR_API_URL = server.apiUrl
    delete process.env.ORCA_E2E_USER_DATA_DIR
    const { loadLinearSdk } = await import('../../linear/linear-sdk')

    expect(() => new (loadLinearSdk().LinearClient)({ apiKey: FAKE_KEY })).toThrow('Linear is off')
    expect(server.requests).toEqual([])
  })
})
