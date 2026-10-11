import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_METHODS } from './session-tabs'

describe('session.tabs.createTerminal agentArgs (Pod)', () => {
  it('hands the arguments to the runtime as given', async () => {
    const createMobileSessionTerminal = vi.fn().mockResolvedValue({ tab: null })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher only calls these two members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'session.tabs.createTerminal',
      params: { worktree: 'id:wt-1', agent: 'claude', agentArgs: ['--model', 'a b; c'] }
    })

    expect(response.ok).toBe(true)
    expect(createMobileSessionTerminal.mock.calls[0]?.[1]).toMatchObject({
      agent: 'claude',
      agentArgs: ['--model', 'a b; c']
    })
  })
})
