import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { denyRpcMethodForCaller } from '../../runtime/rpc/rpc-caller-scope'
import {
  isPodTerminalProcessesEnabled,
  listPodTerminalProcesses,
  type PodPtyProcessList
} from './pod-terminal-processes'
import { createPodTerminalProcessesMethods } from './pod-terminal-processes-rpc-methods'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler never reads the context.
const ctx = {} as RpcContext

function call(methods: ReturnType<typeof createPodTerminalProcessesMethods>): unknown {
  const [entry] = eraseRpcMethods(methods)
  if (!entry || isStreamingMethod(entry)) {
    throw new Error('missing terminal.processes')
  }
  return entry.handler(undefined, ctx)
}

describe('Pod terminal processes', () => {
  it('maps the local inventory to pids and worktrees, never another host', async () => {
    const source = vi.fn<PodPtyProcessList>(async () => [
      {
        id: 'wt1@@a',
        rootProcessId: 4242,
        worktreeId: 'repo::/w1',
        terminalHandle: 'term_a',
        cwd: '/w1',
        title: 'shell'
      },
      { id: 'wt2@@b', cwd: '/w2', title: 'shell' }
    ])
    const rows = await listPodTerminalProcesses(source, new Map(), () => 1_000)
    expect(source).toHaveBeenCalledWith('local', { deadlineMs: 3_000 })
    expect(rows).toEqual([
      { ptyId: 'wt1@@a', worktreeId: 'repo::/w1', handle: 'term_a', shellPid: 4242 },
      { ptyId: 'wt2@@b' }
    ])
    // A headless runtime's `serve-…` PTY names no worktree: the runtime's records place it.
    const serve = vi.fn<PodPtyProcessList>(async () => [
      { id: 'serve-1', rootProcessId: 5, cwd: '/w3', title: 'shell' }
    ])
    const placements = new Map([['serve-1', { worktreeId: 'repo::/w3', handle: 'term_s' }]])
    expect(await listPodTerminalProcesses(serve, placements)).toEqual([
      { ptyId: 'serve-1', worktreeId: 'repo::/w3', handle: 'term_s', shellPid: 5 }
    ])
    // Nothing until main installed the controller.
    await expect(listPodTerminalProcesses(null)).rejects.toThrow(/not available yet/)
  })

  it('answers only in a Pod build or with the override', () => {
    expect(isPodTerminalProcessesEnabled({}, () => true)).toBe(true)
    expect(isPodTerminalProcessesEnabled({}, () => false)).toBe(false)
    expect(isPodTerminalProcessesEnabled({ POD_TERMINAL_PROCESSES: '1' }, () => false)).toBe(true)
    expect(isPodTerminalProcessesEnabled({ POD_TERMINAL_PROCESSES: '0' }, () => true)).toBe(false)
  })

  it('refuses phones and SSH hosts, and costs nothing until called', async () => {
    const list = vi.fn(async () => [{ ptyId: 'p', shellPid: 7 }])
    const [method] = createPodTerminalProcessesMethods(() => true, list)
    expect(method?.name).toBe('terminal.processes')
    expect(method?.permission).toBe('host-admin')
    expect(list).not.toHaveBeenCalled()
    expect(denyRpcMethodForCaller({ kind: 'owner' }, 'terminal.processes', 'host-admin')).toBeNull()
    expect(
      denyRpcMethodForCaller({ kind: 'mobile' }, 'terminal.processes', 'host-admin')
    ).not.toBeNull()
    expect(
      denyRpcMethodForCaller(
        { kind: 'ssh-bridge', targetId: 't', remoteCliControl: true },
        'terminal.processes',
        'host-admin'
      )
    ).not.toBeNull()
    expect(
      denyRpcMethodForCaller(
        { kind: 'ssh-bridge', targetId: 't', remoteCliControl: false },
        'terminal.processes',
        'host-admin'
      )
    ).not.toBeNull()
  })

  it('refuses outside a Pod build', async () => {
    await expect(
      call(
        createPodTerminalProcessesMethods(
          () => false,
          async () => []
        )
      )
    ).rejects.toThrow(/not reported/)
    await expect(
      call(
        createPodTerminalProcessesMethods(
          () => true,
          async () => [{ ptyId: 'p' }]
        )
      )
    ).resolves.toEqual({ terminals: [{ ptyId: 'p' }] })
  })
})
