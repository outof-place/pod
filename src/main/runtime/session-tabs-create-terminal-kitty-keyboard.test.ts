// session.tabs.createTerminal carries terminal.create's kitty keyboard flag to the PTY spawn, so
// the startup responder answers an agent's `CSI ? u` before any view attaches.
import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import type { OrcaRuntimeService as RuntimeService } from './orca-runtime'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import {
  RUNTIME_CAPABILITIES,
  SESSION_TABS_CREATE_TERMINAL_KEYBOARD_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')

describe('session.tabs.createTerminal kitty keyboard flag', () => {
  it('is advertised and handed to the runtime only when set', async () => {
    expect(RUNTIME_CAPABILITIES).toContain(SESSION_TABS_CREATE_TERMINAL_KEYBOARD_RUNTIME_CAPABILITY)
    const createMobileSessionTerminal = vi.fn().mockResolvedValue({ tab: null })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher only calls these two members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as RuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const create = (params: Record<string, unknown>) =>
      dispatcher.dispatch({
        id: 'req-1',
        authToken: 'tok',
        method: 'session.tabs.createTerminal',
        params: { worktree: 'id:wt-1', agent: 'claude', ...params }
      })

    expect((await create({ terminalKittyKeyboardProtocol: true })).ok).toBe(true)
    expect(createMobileSessionTerminal.mock.calls[0]?.[1]).toMatchObject({
      terminalKittyKeyboardProtocol: true
    })
    expect((await create({})).ok).toBe(true)
    expect(createMobileSessionTerminal.mock.calls[1]?.[1]).not.toHaveProperty(
      'terminalKittyKeyboardProtocol'
    )
  })

  it('reaches the PTY spawn of a runtime-owned terminal', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-kitty' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'headless:active-generation',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      terminalKittyKeyboardProtocol: true
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ terminalKittyKeyboardProtocol: true })
    )
  })
})
