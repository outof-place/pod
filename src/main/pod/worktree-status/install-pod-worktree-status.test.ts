import { afterEach, describe, expect, it, vi } from 'vitest'
import { PodClientEventsSubscribeParams } from '../../../shared/rpc-contract/pod-client-events-params'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-types'
import {
  installPodWorktreeStatus,
  isPodWorktreeStatusEventEnabled,
  podWorktreeStatusReadyFields,
  subscribePodWorktreeStatus,
  uninstallPodWorktreeStatusForTests
} from './install-pod-worktree-status'

function makeStore() {
  return {
    getStatusSnapshot: () => [],
    subscribeStatusRowMutations: vi.fn(() => () => {}),
    subscribeStatusFreshness: vi.fn(() => () => {})
  }
}

const catalog: RuntimeWorktreePsResult = { worktrees: [], totalCount: 0, truncated: false }

function makeContext() {
  return { runtime: { getWorktreePs: vi.fn(async () => catalog) } }
}

describe('isPodWorktreeStatusEventEnabled', () => {
  it('follows the identity unless the env overrides it', () => {
    expect(isPodWorktreeStatusEventEnabled({}, () => true)).toBe(true)
    expect(isPodWorktreeStatusEventEnabled({}, () => false)).toBe(false)
    expect(isPodWorktreeStatusEventEnabled({ POD_WORKTREE_STATUS_EVENT: '1' }, () => false)).toBe(
      true
    )
    expect(isPodWorktreeStatusEventEnabled({ POD_WORKTREE_STATUS_EVENT: '0' }, () => true)).toBe(
      false
    )
  })
})

describe('PodClientEventsSubscribeParams', () => {
  it('drops a malformed opt-in or body instead of refusing the subscription', () => {
    expect(PodClientEventsSubscribeParams.parse({})).toEqual({})
    expect(PodClientEventsSubscribeParams.parse([])).toEqual({})
    expect(PodClientEventsSubscribeParams.parse('x')).toEqual({})
    expect(PodClientEventsSubscribeParams.parse({ worktreeStatus: 'yes' })).toEqual({})
    expect(PodClientEventsSubscribeParams.parse({ worktreeStatus: true })).toEqual({
      worktreeStatus: true
    })
    expect(
      PodClientEventsSubscribeParams.parse({ worktreeStatus: { limit: 10_000 }, other: 1 })
    ).toEqual({ worktreeStatus: { limit: 10_000 } })
    expect(
      PodClientEventsSubscribeParams.parse({ worktreeStatus: { limit: 10_000, agents: true } })
    ).toEqual({ worktreeStatus: { limit: 10_000, agents: true } })
    // A malformed `agents` costs only itself.
    expect(
      PodClientEventsSubscribeParams.parse({ worktreeStatus: { limit: 10_000, agents: 'yes' } })
    ).toEqual({ worktreeStatus: { limit: 10_000 } })
  })
})

describe('subscribePodWorktreeStatus', () => {
  afterEach(() => {
    uninstallPodWorktreeStatusForTests()
  })

  it('is a no-op without Pod or without the opt-in', () => {
    const context = makeContext()
    expect(subscribePodWorktreeStatus({ worktreeStatus: true }, context, vi.fn())).toBeNull()
    installPodWorktreeStatus(makeStore(), false)
    expect(subscribePodWorktreeStatus({ worktreeStatus: true }, context, vi.fn())).toBeNull()
    installPodWorktreeStatus(makeStore(), true)
    expect(subscribePodWorktreeStatus({}, context, vi.fn())).toBeNull()
    expect(subscribePodWorktreeStatus(undefined, context, vi.fn())).toBeNull()
    expect(context.runtime.getWorktreePs).not.toHaveBeenCalled()
  })

  it('reads with the subscription params, as worktree.ps would', async () => {
    const store = makeStore()
    installPodWorktreeStatus(store, true)
    const context = makeContext()
    const stop = subscribePodWorktreeStatus({ worktreeStatus: { limit: 10_000 } }, context, vi.fn())
    expect(stop).toEqual(expect.any(Function))
    expect(store.subscribeStatusRowMutations).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(context.runtime.getWorktreePs).toHaveBeenCalledWith(10_000, true))
    stop?.()
  })

  it('names in the ready frame what it honours: the push, and the agent rows when asked', () => {
    installPodWorktreeStatus(makeStore(), true)
    const context = makeContext()
    const plain = { worktreeStatus: true as const }
    const withAgents = { worktreeStatus: { limit: 10_000, agents: true as const } }
    const stopPlain = subscribePodWorktreeStatus(plain, context, vi.fn())
    const stopAgents = subscribePodWorktreeStatus(withAgents, context, vi.fn())
    expect(podWorktreeStatusReadyFields(plain, stopPlain)).toEqual({ worktreeStatus: true })
    expect(podWorktreeStatusReadyFields(withAgents, stopAgents)).toEqual({
      worktreeStatus: true,
      worktreeStatusAgents: true
    })
    expect(podWorktreeStatusReadyFields(withAgents, null)).toEqual({})
    stopPlain?.()
    stopAgents?.()
  })
})
