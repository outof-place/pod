import { vi } from 'vitest'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../../../src/main/providers/ssh-pty-provider'
import {
  HEADER_LENGTH,
  MessageType,
  parseJsonRpcMessage
} from '../../../src/main/ssh/relay-protocol'
import { createPtyWriteInput } from '../../../src/main/ipc/pty/ipc/write-input'
import type { IPtyProvider } from '../../../src/main/providers/types'
import type * as PtyProviderRegistry from '../../../src/main/ipc/pty/provider/registry'
import { ptyOwnership } from '../../../src/main/ipc/pty/provider/ownership-state'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { makeStore } from '../../../src/main/runtime/runtime-rpc-worktree-store-fixtures'

const io = vi.hoisted(() => ({
  getProvider: (): IPtyProvider => {
    throw new Error('provider not installed')
  },
  rpc: vi.fn()
}))
export { io }
vi.mock('../../../src/main/ipc/pty/provider/registry', async (importOriginal) => {
  const original = await importOriginal<typeof PtyProviderRegistry>()
  return {
    ...original,
    tryGetProviderForPty: () => io.getProvider(),
    getProviderForPty: () => io.getProvider()
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ terminalLayoutsByTabId: {} }) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: (...args: unknown[]) => io.rpc(...args)
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: (id: string) => (id.startsWith('remote:') ? 'owner' : null),
  getRemoteRuntimeTerminalHandle: (id: string) => (id.startsWith('remote:') ? 'terminal' : null)
}))

export function createSshDelivery(mode: 'accepted' | 'lost' | 'slow' = 'accepted') {
  const bytes: string[] = []
  const mux = new SshChannelMultiplexer({
    supportsWriteSettlement: true,
    onData: () => {},
    onClose: () => {},
    write: (frame, callback) => {
      if (frame[0] !== MessageType.Regular) {
        callback?.({ ok: true })
        return true
      }
      const message = parseJsonRpcMessage(frame.subarray(HEADER_LENGTH))
      if (
        !('method' in message) ||
        message.method !== 'pty.data' ||
        typeof message.params?.data !== 'string'
      ) {
        throw new Error('unexpected transport frame')
      }
      bytes.push(message.params.data)
      const settle = (): void =>
        callback?.(
          mode === 'lost'
            ? { ok: false, error: new Error('lost write acknowledgment') }
            : { ok: true }
        )
      if (mode === 'lost') {
        setTimeout(settle, 10)
      } else if (mode === 'slow' && message.params.data.startsWith('X')) {
        setTimeout(settle, 1300)
      } else {
        settle()
      }
      return true
    }
  })
  const provider = new SshPtyProvider('connection', mux)
  vi.spyOn(provider, 'hasPty').mockReturnValue(true)
  // Fork-only (Pod): a guarded write asks the relay who is in front first; this transport carries
  // only pty.data, so the relay's answer is stubbed: null names no shell, and the write goes on.
  const foreground = vi.spyOn(provider, 'getForegroundProcess').mockResolvedValue(null)
  const settlement = vi.spyOn(provider, 'writeWithSettlement')
  io.getProvider = () => provider
  const input = createPtyWriteInput({})
  const id = 'ssh:connection@@pty-1'
  ptyOwnership.set(id, 'connection')
  vi.stubGlobal('window', {
    api: {
      pty: {
        write: (ptyId: string, data: string, inputKind: 'driving') =>
          input.writePtyInput({ id: ptyId, data, inputKind }),
        writeAccepted: (
          ptyId: string,
          data: string,
          inputKind: 'driving',
          options?: { requireWriteSettlement?: true }
        ) => input.writePtyInputAccepted({ id: ptyId, data, inputKind, ...options })
      }
    }
  })
  return {
    id,
    bytes,
    provider,
    settlement,
    foreground,
    close: () => {
      ptyOwnership.delete(id)
      provider.dispose()
      mux.dispose()
    }
  }
}

export async function createPairedRuntime(ssh: ReturnType<typeof createSshDelivery>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This leaf-only fixture uses the existing store stub and never invokes repository mutations.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    write: (_, data) => ssh.provider.write(ssh.id, data),
    writeWithSettlement: (_, data) => ssh.provider.writeWithSettlement(ssh.id, data),
    hasPty: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: 'repo-1::/tmp/worktree-a',
        title: 'Codex',
        activeLeafId: '11111111-1111-4111-8111-111111111111',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: 'repo-1::/tmp/worktree-a',
        leafId: '11111111-1111-4111-8111-111111111111',
        paneRuntimeId: 1,
        ptyId: ssh.id,
        paneTitle: null,
        title: ''
      }
    ]
  })
  const { terminals } = await runtime.listTerminals('id:repo-1::/tmp/worktree-a')
  if (!terminals[0]) {
    throw new Error('terminal fixture missing')
  }
  return { runtime, handle: terminals[0].handle }
}
