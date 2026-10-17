import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { POD_SESSION_TAB_RESTART_METHODS } from './pod-session-tabs-restart'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { POD_SESSION_TABS_RESTART_TERMINAL_RUNTIME_CAPABILITY } from '../../../../shared/pod-runtime-capabilities'

function dispatch(params: unknown) {
  const restartExitedMobileSessionTerminal = vi.fn(async () => ({ terminal: 'term_new' }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only this member.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    restartExitedMobileSessionTerminal
  } as unknown as OrcaRuntimeService
  const response = new RpcDispatcher({
    runtime,
    methods: POD_SESSION_TAB_RESTART_METHODS
  }).dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'session.tabs.restartTerminal',
    params
  })
  return { response, restartExitedMobileSessionTerminal }
}

describe('session.tabs.restartTerminal (Pod)', () => {
  it('hands the pane to the runtime and answers its new handle', async () => {
    const { response, restartExitedMobileSessionTerminal } = dispatch({
      worktree: 'id:wt',
      tabId: 'tab',
      leafId: 'left'
    })
    expect(await response).toMatchObject({ ok: true, result: { terminal: 'term_new' } })
    expect(restartExitedMobileSessionTerminal).toHaveBeenCalledWith('id:wt', 'tab', 'left')
  })

  it.each([{ worktree: 'id:wt' }, { tabId: 'tab' }, { worktree: 'id:wt', tabId: 'tab', extra: 1 }])(
    'refuses %j',
    async (params) => {
      const { response, restartExitedMobileSessionTerminal } = dispatch(params)
      expect((await response).ok).toBe(false)
      expect(restartExitedMobileSessionTerminal).not.toHaveBeenCalled()
    }
  )

  it('is a workspace method, and Pod hosts say they serve it', () => {
    expect(POD_SESSION_TAB_RESTART_METHODS[0]?.permission).toBe('workspace')
    expect(RUNTIME_CAPABILITIES).toContain(POD_SESSION_TABS_RESTART_TERMINAL_RUNTIME_CAPABILITY)
  })
})
