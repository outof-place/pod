import '../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { CLIENT_EVENT_METHODS } from '../../runtime/rpc/methods/client-events'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../shared/runtime-types'
import type { PodAgentStatusRow } from './worktree-status-signature'
import { psRow } from './worktree-ps-row.test-fixture'
import {
  installPodWorktreeStatus,
  uninstallPodWorktreeStatusForTests
} from './install-pod-worktree-status'

const agent = {
  paneKey: 'tab-1:leaf-1',
  parentPaneKey: null,
  agentType: 'claude',
  prompt: 'Fix the flaky login test',
  taskTitle: null,
  displayName: null,
  lastAssistantMessage: null,
  toolName: 'Bash',
  toolInput: 'pnpm test login',
  interrupted: false,
  stateStartedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000
} as const

// The three kinds of workspace a row can be: the hub forwards each as worktree.ps built it.
const WORKSPACES: [string, Partial<RuntimeWorktreePsSummary>][] = [
  ['a git worktree', { workspaceKind: 'git' }],
  ['a folder workspace', { workspaceKind: 'folder-workspace', branch: '', path: '/work/notes' }],
  [
    'a worktree on an SSH host that lost contact',
    { hostId: 'ssh:build-box', liveTerminalCount: 0, unverifiableTerminalCount: 1 }
  ]
]

function makeHarness(catalog: { current: RuntimeWorktreePsResult }) {
  let rows: PodAgentStatusRow[] = []
  const mutations = new Set<() => void>()
  const cleanups = new Map<string, () => void>()
  const store = {
    getStatusSnapshot: () => rows,
    subscribeStatusRowMutations: (listener: () => void) => {
      mutations.add(listener)
      return () => mutations.delete(listener)
    },
    subscribeStatusFreshness: () => () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two methods under test call only these runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getWorktreePs: vi.fn(async () => structuredClone(catalog.current)),
    onClientEvent: () => () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    recordFeatureInteraction: () => {}
  } as unknown as OrcaRuntimeService
  installPodWorktreeStatus(store, true)
  return {
    runtime,
    dispatcher: new RpcDispatcher({
      runtime,
      methods: [...CLIENT_EVENT_METHODS, ...WORKTREE_METHODS]
    }),
    write(next: PodAgentStatusRow[]) {
      rows = next
      mutations.forEach((listener) => listener())
    },
    end: () => cleanups.forEach((cleanup) => cleanup())
  }
}

type Frame = { result?: Record<string, unknown> }

describe('worktreeStatusChanged on the wire', () => {
  afterEach(() => {
    uninstallPodWorktreeStatusForTests()
  })

  it.each(WORKSPACES)(
    'carries the row worktree.ps returns at the same snapshot, for %s',
    async (_kind, workspace) => {
      const before = psRow('wt-a', 'working', {
        ...workspace,
        agents: [{ ...agent, state: 'working' }]
      })
      const other = psRow('wt-b', 'active')
      const catalog = { current: { worktrees: [before, other], totalCount: 2, truncated: false } }
      const harness = makeHarness(catalog)
      const frames: Frame[] = []
      void harness.dispatcher.dispatchStreaming(
        {
          id: 'events',
          authToken: 'token',
          method: 'runtime.clientEvents.subscribe',
          params: { worktreeStatus: { limit: 10_000, agents: true, rows: true } }
        },
        (frame) => frames.push(JSON.parse(frame)),
        { connectionId: 'native-1' }
      )
      await vi.waitFor(() => expect(harness.runtime.getWorktreePs).toHaveBeenCalledTimes(1))

      // The agent asks for a permission: the host's catalog and its hook store move together.
      catalog.current = {
        ...catalog.current,
        worktrees: [
          psRow('wt-a', 'permission', {
            ...workspace,
            agents: [{ ...agent, state: 'waiting', toolName: null, toolInput: null }]
          }),
          other
        ]
      }
      harness.write([
        { paneKey: agent.paneKey, worktreeId: 'wt-a', state: 'waiting', receivedAt: Date.now() }
      ])
      const event = await vi.waitFor(() => {
        const found = frames.find((frame) => frame.result?.type === 'worktreeStatusChanged')
        expect(found).toBeDefined()
        return found!.result!
      })

      const answer = await harness.dispatcher.dispatch({
        id: 'ps',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, afterSnapshotId: null }
      })
      const read = JSON.parse(JSON.stringify(answer)).result
      expect(event.snapshotId).toBe(read.snapshotId)
      expect(event.worktree).toEqual(
        read.worktrees.find((row: RuntimeWorktreePsSummary) => row.worktreeId === 'wt-a')
      )
      harness.end()
    }
  )

  it('sends an older client the event it knew, so it reads as before', async () => {
    const catalog = {
      current: { worktrees: [psRow('wt-a', 'working')], totalCount: 1, truncated: false }
    }
    const harness = makeHarness(catalog)
    const frames: Frame[] = []
    void harness.dispatcher.dispatchStreaming(
      {
        id: 'events',
        authToken: 'token',
        method: 'runtime.clientEvents.subscribe',
        params: { worktreeStatus: { limit: 10_000 } }
      },
      (frame) => frames.push(JSON.parse(frame)),
      { connectionId: 'native-1' }
    )
    await vi.waitFor(() => expect(harness.runtime.getWorktreePs).toHaveBeenCalledTimes(1))
    catalog.current = { ...catalog.current, worktrees: [psRow('wt-a', 'done')] }
    harness.write([
      { paneKey: 'tab-1:leaf-1', worktreeId: 'wt-a', state: 'done', receivedAt: Date.now() }
    ])
    const event = await vi.waitFor(() => {
      const found = frames.find((frame) => frame.result?.type === 'worktreeStatusChanged')
      expect(found).toBeDefined()
      return found!.result!
    })
    const answer = await harness.dispatcher.dispatch({
      id: 'ps',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: null }
    })
    const snapshotId = JSON.parse(JSON.stringify(answer)).result.snapshotId

    // Without `rows` the event is the shape it was before the row: nothing more to parse.
    expect(event).toEqual({
      type: 'worktreeStatusChanged',
      worktreeId: 'wt-a',
      snapshotId,
      status: 'done'
    })
    // A client holding that snapshot still skips its read: worktree.ps answers it unchanged.
    const conditional = await harness.dispatcher.dispatch({
      id: 'ps-after',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: snapshotId }
    })
    expect(conditional).toMatchObject({ ok: true, result: { unchanged: true, snapshotId } })
    harness.end()
  })
})
