// A reply between the socket's buffered ceiling and the frame limit must fail alone, not close the stream.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { openLocalStreamTestClient } from './runtime-rpc-local-stream-test-harness'
import { RUNTIME_RPC_REPLY_TOO_LARGE_CODE } from './runtime-rpc/runtime-rpc-reply-size-limit'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES } from './rpc/unix-socket-stream-connection'

describe('local stream reply ceiling', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_LOCAL_STREAM_TRANSPORT', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('answers a reply over the buffered ceiling with reply_too_large and keeps the stream', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rls-ceiling-'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared RPC fixture implements only the store methods these RPC paths read, as in the WebSocket streaming tests.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const status = runtime.getStatus()
    // 33 MiB: under the 64 MiB frame limit, over the 32 MiB a socket may buffer.
    const padding = 'x'.repeat(UNIX_SOCKET_STREAM_MAX_BUFFERED_BYTES + 1024 * 1024)
    const getStatus = vi.spyOn(runtime, 'getStatus')
    getStatus.mockReturnValueOnce(Object.assign({}, status, { padding }))
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    const endpoint = metadata?.transports[0]?.endpoint
    const authToken = metadata?.authToken
    if (!endpoint || !authToken) {
      throw new Error('runtime metadata was not published')
    }
    const client = await openLocalStreamTestClient(endpoint, authToken)
    try {
      client.sendRequest({ id: 'big', method: 'status.get' })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(
          expect.objectContaining({
            id: 'big',
            ok: false,
            error: expect.objectContaining({ code: RUNTIME_RPC_REPLY_TOO_LARGE_CODE })
          })
        )
      )
      client.sendRequest({ id: 'small', method: 'status.get' })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(expect.objectContaining({ id: 'small', ok: true }))
      )
      expect(client.socket.destroyed).toBe(false)
    } finally {
      client.close()
      await server.stop()
    }
  })
})
