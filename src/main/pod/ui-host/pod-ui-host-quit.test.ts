import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodUiHostQuitBlockers } from '../../../shared/pod-ui-host-quit'
import type { PodUiHostServerMessage } from './pod-ui-host-protocol'
import { PodUiHostQuitFlow, POD_UI_HOST_QUIT_HEARTBEAT_MS } from './pod-ui-host-quit'

const flows: PodUiHostQuitFlow[] = []

afterEach(() => {
  for (const flow of flows.splice(0)) {
    flow.dispose()
  }
  vi.useRealTimers()
})

function makeFlow(blockers: PodUiHostQuitBlockers | null | Error = null, runningAgents = 0) {
  const sent: PodUiHostServerMessage[] = []
  const deps = {
    assess: vi.fn(async () => {
      if (blockers instanceof Error) {
        throw blockers
      }
      return blockers
    }),
    runningAgents: () => runningAgents,
    commit: vi.fn(),
    send: (message: PodUiHostServerMessage) => {
      sent.push(message)
      return true
    },
    log: vi.fn()
  }
  const flow = new PodUiHostQuitFlow(deps)
  flows.push(flow)
  return { flow, deps, sent }
}

const heartbeats = (sent: PodUiHostServerMessage[]): number =>
  sent.filter((message) => message.type === 'quitHeartbeat').length

describe('PodUiHostQuitFlow', () => {
  it('commits a quit nothing blocks, then beats every second until exit', async () => {
    vi.useFakeTimers()
    const { flow, deps, sent } = makeFlow({ unsavedFiles: 0, remoteWork: 'none' })
    await flow.request('user', false)
    expect(sent[0]).toEqual({ type: 'quitting', reason: 'user' })
    expect(deps.commit).toHaveBeenCalledWith('user')
    expect(flow.isCommitted).toBe(true)
    vi.advanceTimersByTime(POD_UI_HOST_QUIT_HEARTBEAT_MS * 3)
    expect(heartbeats(sent)).toBe(3)
  })

  it('asks for confirmation over unsaved changes and quits nothing (the user cancels)', async () => {
    vi.useFakeTimers()
    const { flow, deps, sent } = makeFlow({ unsavedFiles: 2, remoteWork: 'running' }, 3)
    await flow.request('user', false)
    expect(sent).toEqual([
      {
        type: 'needsConfirmation',
        reason: 'unsavedChanges',
        unsavedFiles: 2,
        remoteWork: 'running',
        runningAgents: 3
      }
    ])
    expect(deps.commit).not.toHaveBeenCalled()
    expect(flow.isCommitted).toBe(false)
    // Cancelled in PodNative: no second quit comes, and no heartbeat ever starts.
    vi.advanceTimersByTime(POD_UI_HOST_QUIT_HEARTBEAT_MS * 5)
    expect(heartbeats(sent)).toBe(0)
  })

  it('asks for confirmation over remote work a quit would leave', async () => {
    const { flow, sent } = makeFlow({ unsavedFiles: 0, remoteWork: 'unverifiable' })
    await flow.request('update', false)
    expect(sent).toEqual([
      {
        type: 'needsConfirmation',
        reason: 'remoteWork',
        unsavedFiles: 0,
        remoteWork: 'unverifiable',
        runningAgents: 0
      }
    ])
  })

  it('commits a confirmed quit without asking again (the user accepted)', async () => {
    const { flow, deps, sent } = makeFlow({ unsavedFiles: 2, remoteWork: 'none' })
    await flow.request('user', false)
    await flow.request('user', true)
    expect(deps.assess).toHaveBeenCalledTimes(1)
    expect(sent.map((message) => message.type)).toEqual(['needsConfirmation', 'quitting'])
    expect(deps.commit).toHaveBeenCalledWith('user')
  })

  it.each([
    ['no renderer answered', null],
    ['the assessment threw', new Error('store read failed')]
  ])('commits when %s', async (_name, blockers) => {
    const { flow, deps, sent } = makeFlow(blockers)
    await flow.request('update', false)
    expect(sent[0]).toEqual({ type: 'quitting', reason: 'update' })
    expect(deps.commit).toHaveBeenCalledWith('update')
  })

  it('answers a repeated quit while going without a second commit', async () => {
    const { flow, deps, sent } = makeFlow()
    await flow.request('update', false)
    await flow.request('user', false)
    expect(sent.filter((message) => message.type === 'quitting')).toEqual([
      { type: 'quitting', reason: 'update' },
      { type: 'quitting', reason: 'update' }
    ])
    expect(deps.commit).toHaveBeenCalledTimes(1)
  })

  it('ignores a quit that arrives while the first is still being assessed', async () => {
    const { flow, deps } = makeFlow()
    await Promise.all([flow.request('user', false), flow.request('user', false)])
    expect(deps.assess).toHaveBeenCalledTimes(1)
    expect(deps.commit).toHaveBeenCalledTimes(1)
  })

  it('reports a vetoed quit and stops beating, so PodNative keeps Pod running', async () => {
    vi.useFakeTimers()
    const { flow, sent } = makeFlow()
    await flow.request('user', false)
    vi.advanceTimersByTime(POD_UI_HOST_QUIT_HEARTBEAT_MS)
    flow.aborted('the session could not be saved')
    const beats = heartbeats(sent)
    vi.advanceTimersByTime(POD_UI_HOST_QUIT_HEARTBEAT_MS * 5)
    expect(heartbeats(sent)).toBe(beats)
    expect(sent.at(-1)).toEqual({ type: 'quitAborted', reason: 'the session could not be saved' })
    expect(flow.isCommitted).toBe(false)
  })

  it('reports no veto before a quit commits', () => {
    const { flow, sent } = makeFlow()
    flow.aborted('late')
    expect(sent).toEqual([])
  })
})
