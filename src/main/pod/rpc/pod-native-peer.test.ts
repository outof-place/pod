import { mkdtempSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../../product-identity/product-identity'
import type { ProductIdentity } from '../../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../../product-identity/product-identity.test-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { readRuntimeMetadata } from '../../runtime/runtime-metadata'
import { OrcaRuntimeRpcServer } from '../../runtime/runtime-rpc'
import { sendRequest } from '../../runtime/runtime-rpc-test-harness'
import { openLocalStreamTestClient } from '../../runtime/runtime-rpc-local-stream-test-harness'
import { makeStore } from '../../runtime/runtime-rpc-worktree-store-fixtures'
import type { PodPeerCheck } from '../ui-host/pod-peer-identity'
import { podNativePeerCheck, setPodNativePeerVerifierLoader } from './pod-native-peer'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

const servers: OrcaRuntimeRpcServer[] = []

beforeEach(() => {
  vi.stubEnv('ORCA_LOCAL_STREAM_TRANSPORT', '1')
})

afterEach(async () => {
  identity.current = null
  setPodNativePeerVerifierLoader(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

/** A runtime whose peer check answers `peer` for every local stream it accepts. */
async function startRuntime(peer: PodPeerCheck) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'pod-native-peer-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared RPC fixture implements only the store methods these RPC paths read, as in the local stream tests.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const setSessionSearchEnabled = vi.fn(async () => {})
  Object.assign(runtime, { setSessionSearchEnabled })
  const verify = vi.fn((_socket: Socket) => peer)
  setPodNativePeerVerifierLoader(() => verify)
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
  servers.push(server)
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)
  const endpoint = metadata?.transports[0]?.endpoint
  const authToken = metadata?.authToken
  if (!endpoint || !authToken) {
    throw new Error('runtime metadata was not published')
  }
  return { endpoint, authToken, setSessionSearchEnabled, verify }
}

const consent = (id: string, params: Record<string, unknown>) => ({
  id,
  method: 'aiVault.setSearchEnabled',
  params
})

async function overLocalStream(
  endpoint: string,
  authToken: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = await openLocalStreamTestClient(endpoint, authToken)
  try {
    client.sendRequest(consent('consent', params))
    await vi.waitFor(() => expect(client.responses).toHaveLength(1))
    return client.responses[0]!
  } finally {
    client.close()
    await client.closed
  }
}

describe('session search consent from PodNative (Pod)', () => {
  it('refuses the owner token over the CLI socket, even for a user reason', async () => {
    identity.current = podIdentityWithoutStablyServices()
    const { endpoint, authToken, setSessionSearchEnabled, verify } = await startRuntime({
      ok: true,
      pid: 4242
    })

    const response = await sendRequest(endpoint, {
      ...consent('cli', { enabled: true, reason: 'user' }),
      authToken
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('admits PodNative verified by its audit token, for the user, and logs it', async () => {
    identity.current = podIdentityWithoutStablyServices()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { endpoint, authToken, setSessionSearchEnabled } = await startRuntime({
      ok: true,
      pid: 4242
    })

    const response = await overLocalStream(endpoint, authToken, { enabled: true, reason: 'user' })

    expect(response).toMatchObject({ id: 'consent', ok: true })
    expect(setSessionSearchEnabled).toHaveBeenCalledExactlyOnceWith(true)
    expect(warn).toHaveBeenCalledWith(
      '[ai-vault-search] PodNative pid 4242 (user) set indexing enabled=true'
    )
  })

  it('refuses a local stream whose peer is not PodNative', async () => {
    identity.current = podIdentityWithoutStablyServices()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { endpoint, authToken, setSessionSearchEnabled } = await startRuntime({
      ok: false,
      pid: 999,
      error: 'code failed to satisfy specified code requirement(s)'
    })

    const response = await overLocalStream(endpoint, authToken, { enabled: true, reason: 'user' })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
  })

  it('refuses verified PodNative without the user reason', async () => {
    identity.current = podIdentityWithoutStablyServices()
    const { endpoint, authToken, setSessionSearchEnabled, verify } = await startRuntime({
      ok: true,
      pid: 4242
    })

    const response = await overLocalStream(endpoint, authToken, { enabled: true })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('keeps upstream refusal without Pod identity', async () => {
    const { endpoint, authToken, setSessionSearchEnabled } = await startRuntime({
      ok: true,
      pid: 4242
    })

    const response = await overLocalStream(endpoint, authToken, { enabled: true, reason: 'user' })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
  })
})

describe('podNativePeerCheck', () => {
  it('checks a connection once, on first use', () => {
    identity.current = podIdentityWithoutStablyServices()
    const verify = vi.fn((): PodPeerCheck => ({ ok: true, pid: 7 }))
    const load = vi.fn(() => verify)
    setPodNativePeerVerifierLoader(load)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake verifier never reads the socket.
    const check = podNativePeerCheck({} as Socket)

    expect(load).not.toHaveBeenCalled()
    expect(check?.()).toEqual({ ok: true, pid: 7 })
    expect(check?.()).toEqual({ ok: true, pid: 7 })
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('answers not PodNative when the addon is missing, and nothing on orcad', () => {
    identity.current = podIdentityWithoutStablyServices()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no verifier reads the socket.
    const socket = {} as Socket
    expect(podNativePeerCheck(socket)).toBeNull()
    setPodNativePeerVerifierLoader(() => null)
    expect(podNativePeerCheck(socket)?.()).toMatchObject({ ok: false })
  })
})
