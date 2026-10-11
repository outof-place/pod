// Several views on one terminal: exactly one of them sees each query, so the program gets one reply.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  openLocalStreamTestClient,
  type LocalStreamTestClient
} from './runtime-rpc-local-stream-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { _resetTerminalQueryResponderElectionForTest } from './terminal-query-responder-election'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const PTY = 'responder-pty'
const DA1 = '\x1b[c'
const CPR = '\x1b[6n'
const TerminalCreateResult = z.object({ terminal: z.object({ handle: z.string() }) })
const SpanPayload = z.object({ data: z.string() })

async function startServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rqr-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared RPC fixture implements only the store methods these RPC paths read, as in the WebSocket streaming tests.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY }),
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const answerFromModel = vi.spyOn(runtime, 'answerTerminalQueriesFromModel')
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)
  const endpoint = metadata?.transports[0]?.endpoint
  const authToken = metadata?.authToken
  if (!endpoint || !authToken) {
    throw new Error('runtime metadata was not published')
  }
  const created = await sendRequest(endpoint, {
    id: 'create',
    authToken,
    method: 'terminal.create',
    params: {
      worktree: 'id:repo-1::/tmp/worktree-a',
      command: 'shell',
      tabId: 'responder-tab',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
  })
  const handle = TerminalCreateResult.parse(created.result).terminal.handle
  return { runtime, server, endpoint, authToken, handle, writes, answerFromModel }
}

type Viewer = {
  client: LocalStreamTestClient
  output: () => string
  send: (opcode: number, payload: Uint8Array) => void
}

async function attachViewer(
  endpoint: string,
  authToken: string,
  handle: string,
  id: string
): Promise<Viewer> {
  const client = await openLocalStreamTestClient(endpoint, authToken, {
    protocol: 'orca-local-stream',
    versions: [1],
    clientCapabilities: ['terminal.binary-stream.v1', 'terminal.multiplex.v1']
  })
  client.sendRequest({ id: 'mux', method: 'terminal.multiplex', params: {} })
  await vi.waitFor(() =>
    expect(client.responses).toContainEqual(
      expect.objectContaining({ id: 'mux', result: { type: 'ready' } })
    )
  )
  let seq = 1
  const send = (opcode: number, payload: Uint8Array): void =>
    client.sendBinary(
      encodeTerminalStreamFrame({
        seq: seq++,
        opcode,
        streamId: opcode === TerminalStreamOpcode.Subscribe ? 0 : 7,
        payload
      })
    )
  send(
    TerminalStreamOpcode.Subscribe,
    encodeTerminalStreamJson({
      streamId: 7,
      terminal: handle,
      client: { id, type: 'desktop' },
      capabilities: { ackOutput: 1 }
    })
  )
  await vi.waitFor(() =>
    expect(client.responses).toContainEqual(
      expect.objectContaining({
        id: 'mux',
        result: expect.objectContaining({ type: 'subscribed', streamId: 7 })
      })
    )
  )
  const output = (): string =>
    client.binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .map((frame) => {
        if (frame?.streamId !== 7) {
          return ''
        }
        if (frame.opcode === TerminalStreamOpcode.Output) {
          return decodeTerminalStreamText(frame.payload)
        }
        if (frame.opcode === TerminalStreamOpcode.OutputSpan) {
          return SpanPayload.parse(decodeTerminalStreamJson<unknown>(frame.payload)).data
        }
        return ''
      })
      .join('')
  return { client, output, send }
}

describe('one query responder among several terminal views', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_LOCAL_STREAM_TRANSPORT', '1')
    _resetTerminalQueryResponderElectionForTest()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends each query to one view only, and moves it to the view with the keyboard', async () => {
    const { runtime, server, endpoint, authToken, handle, writes } = await startServer()
    const viewers: Viewer[] = []
    try {
      for (const id of ['first', 'second', 'third']) {
        viewers.push(await attachViewer(endpoint, authToken, handle, id))
      }
      const [first, second, third] = viewers
      runtime.onPtyData(PTY, `one${DA1}two${CPR}\r\n`, 1)
      await vi.waitFor(() => expect(third?.output()).toContain('two'))
      expect(first?.output()).toContain(`one${DA1}two${CPR}`)
      expect(second?.output()).toContain('onetwo')
      expect(third?.output()).toContain('onetwo')
      // A view is the responder, so main's model stays silent.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const modelReplies = writes.filter(
        (write) => write.startsWith('\x1b[') && (write.endsWith('c') || write.endsWith('R'))
      )
      expect(modelReplies).toEqual([])

      // The user types into the third view: the next query goes there alone.
      third?.send(TerminalStreamOpcode.Input, encodeTerminalStreamText('x'))
      await vi.waitFor(() => expect(third?.client.binaryFrames.length).toBeGreaterThan(0))
      await new Promise((resolve) => setTimeout(resolve, 50))
      runtime.onPtyData(PTY, `next${DA1}end\r\n`, 2)
      await vi.waitFor(() => expect(first?.output()).toContain('nextend'))
      expect(second?.output()).toContain('nextend')
      expect(third?.output()).toContain(`next${DA1}end`)

      // A reply from a view that saw no query is not the user: the keyboard stays with the third.
      first?.send(TerminalStreamOpcode.Input, encodeTerminalStreamText('\x1b[?62;22c'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      runtime.onPtyData(PTY, `again${CPR}\r\n`, 3)
      await vi.waitFor(() => expect(first?.output()).toContain('again\r\n'))
      expect(third?.output()).toContain(`again${CPR}`)
    } finally {
      for (const viewer of viewers) {
        viewer.client.close()
      }
      await server.stop()
    }
  })

  it('gives the part of a query a view held back the seq where it ended, once the view answers', async () => {
    const { runtime, server, endpoint, authToken, handle } = await startServer()
    const first = await attachViewer(endpoint, authToken, handle, 'first')
    const second = await attachViewer(endpoint, authToken, handle, 'second')
    try {
      const lead = 'x'.repeat(100)
      runtime.onPtyData(PTY, `${lead}\x1b[`, 1)
      await vi.waitFor(() => expect(second.output()).toContain(lead))
      second.send(TerminalStreamOpcode.Input, encodeTerminalStreamText('k'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      runtime.onPtyData(PTY, '6nb\r\n', 2)
      await vi.waitFor(() => expect(second.output()).toContain(`${lead}${CPR}b`))
      const held = second.client.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find(
          (frame) =>
            frame?.streamId === 7 &&
            frame.opcode === TerminalStreamOpcode.OutputSpan &&
            SpanPayload.parse(decodeTerminalStreamJson<unknown>(frame.payload)).data === '\x1b['
        )
      // A viewer checks each output frame's seq for gaps; the held bytes end at the first chunk's end.
      expect(held?.seq).toBe(lead.length + 2)
    } finally {
      first.client.close()
      second.client.close()
      await server.stop()
    }
  })

  it("has main's model answer a query the responder left before answering", async () => {
    const { runtime, server, endpoint, authToken, handle, answerFromModel } = await startServer()
    const first = await attachViewer(endpoint, authToken, handle, 'first')
    const second = await attachViewer(endpoint, authToken, handle, 'second')
    try {
      runtime.onPtyData(PTY, `q${CPR}\r\n`, 1)
      await vi.waitFor(() => expect(first.output()).toContain(CPR))
      first.client.close()
      await first.client.closed
      await vi.waitFor(() => expect(answerFromModel).toHaveBeenCalledWith(PTY, CPR))

      // An answered query is not answered again when its responder leaves.
      runtime.onPtyData(PTY, `r${DA1}\r\n`, 2)
      await vi.waitFor(() => expect(second.output()).toContain(DA1))
      second.send(TerminalStreamOpcode.Input, encodeTerminalStreamText('\x1b[?62;22c'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      second.client.close()
      await second.client.closed
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(answerFromModel).not.toHaveBeenCalledWith(PTY, DA1)
    } finally {
      await server.stop()
    }
  })
})
