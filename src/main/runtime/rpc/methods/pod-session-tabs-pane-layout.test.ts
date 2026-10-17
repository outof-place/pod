import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { SESSION_TAB_MUTATION_METHODS } from './session-tab-mutation-methods'
import { UpdatePaneLayout } from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { POD_SESSION_TABS_PANE_LAYOUT_SYNC_RUNTIME_CAPABILITY } from '../../../../shared/pod-runtime-capabilities'

const params = {
  worktree: 'id:wt',
  tabId: 'tab',
  root: { type: 'leaf', leafId: 'left' },
  expandedLeafId: null,
  activeLeafId: 'left'
}

async function call(caller: RpcContext['caller']) {
  const method = eraseRpcMethods(SESSION_TAB_MUTATION_METHODS).find(
    (entry) => entry.name === 'session.tabs.updatePaneLayout'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('missing session.tabs.updatePaneLayout')
  }
  const updateMobileSessionPaneLayout = vi.fn(async (_worktree: string, _args: object) => ({
    updated: true
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: without a clientKind the handler reaches only this member.
  const runtime = { updateMobileSessionPaneLayout } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  const context = { runtime, caller } as RpcContext
  await method.handler(UpdatePaneLayout.parse(params), context)
  return updateMobileSessionPaneLayout.mock.calls[0]
}

describe('session.tabs.updatePaneLayout activeLeafId and the window (Pod)', () => {
  it("passes the active pane on, and marks this machine's CLI and PodNative as local", async () => {
    expect(await call({ kind: 'local-cli' })).toEqual([
      'id:wt',
      expect.objectContaining({ activeLeafId: 'left', podLocalCaller: true })
    ])
  })

  it.each([{ kind: 'paired-device', deviceId: 'phone' } as const, { kind: 'desktop' } as const])(
    'never lets %j reach the window',
    async (caller) => {
      expect((await call(caller))?.[1]).toMatchObject({ podLocalCaller: false })
    }
  )

  it('takes an older client without activeLeafId, and refuses an empty one', () => {
    const { activeLeafId: _omitted, ...older } = params
    expect(UpdatePaneLayout.parse(older)).not.toHaveProperty('activeLeafId')
    expect(UpdatePaneLayout.safeParse({ ...params, activeLeafId: '' }).success).toBe(false)
  })

  it('is listed among the capabilities Pod hosts serve', () => {
    expect(RUNTIME_CAPABILITIES).toContain(POD_SESSION_TABS_PANE_LAYOUT_SYNC_RUNTIME_CAPABILITY)
  })
})
