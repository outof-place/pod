import { afterEach, describe, expect, it, vi } from 'vitest'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { classifyRuntimeLongPoll } from '../../runtime/runtime-rpc/runtime-rpc-long-poll'
import {
  setPodBrowserPaneHooks,
  type PodBrowserCobrowseSink
} from '../browser-pane/pod-browser-pane-hooks'
import { POD_BROWSER_COBROWSE_METHODS } from './pod-browser-cobrowse-rpc-methods'

const methods = eraseRpcMethods(POD_BROWSER_COBROWSE_METHODS)

function context() {
  const runtime = {
    browserCobrowseTarget: vi.fn(async () => ({ worktreeId: 'wt-1', browserPageId: 'page-1' })),
    browserElementBox: vi.fn(async () => ({ x: 10, y: 20, width: 30, height: 40 }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers call only these two runtime methods.
  return { runtime, ctx: { runtime } as unknown as RpcContext }
}

function call(name: string, params: unknown, ctx: RpcContext): Promise<unknown> {
  const entry = methods.find((candidate) => candidate.name === name)
  if (!entry || isStreamingMethod(entry)) {
    throw new Error(`missing ${name}`)
  }
  return Promise.resolve(entry.handler(entry.params ? entry.params.parse(params) : undefined, ctx))
}

function install(sink: Partial<PodBrowserCobrowseSink>): void {
  const noop = () => () => {}
  setPodBrowserPaneHooks({
    agentCommand: vi.fn(),
    download: vi.fn(),
    openLink: vi.fn(() => false),
    passkey: vi.fn(() => null),
    holdFramesForCapture: noop,
    cobrowse: { marks: vi.fn(() => null), point: vi.fn(async () => null), ...sink }
  })
}

afterEach(() => setPodBrowserPaneHooks(null))

describe('browser.marks and browser.point', () => {
  it('are workspace verbs behind their own capability', () => {
    expect(methods.map((m) => [m.name, m.permission])).toEqual([
      ['browser.marks', 'workspace'],
      ['browser.point', 'workspace']
    ])
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.browser.cobrowse.v1')
  })

  it('marks --wait is a long poll (keepalive and the abort signal), a plain marks is not', () => {
    const request = (params: unknown) => ({
      id: '1',
      authToken: 't',
      method: 'browser.marks',
      params
    })
    expect(classifyRuntimeLongPoll(request({ wait: true }))).toBe('browser-marks')
    expect(classifyRuntimeLongPoll(request({}))).toBeNull()
  })

  it('a page no pane controller hosts gets a clear refusal, not a hang', async () => {
    install({})
    const { ctx } = context()
    await expect(call('browser.marks', { wait: true }, ctx)).rejects.toThrow(
      'need a Pod browser pane'
    )
  })

  it("an agent-browser ref is resolved by agent-browser's own box, a CSS selector on the page", async () => {
    const point = vi.fn(async () => ({ pointerId: 'p1', box: null, shown: true, cleared: 0 }))
    install({ point })
    const { ctx, runtime } = context()
    await call('browser.point', { element: '@e12', label: 'This one' }, ctx)
    expect(runtime.browserElementBox).toHaveBeenCalledWith({
      element: '@e12',
      worktree: 'wt-1',
      page: 'page-1'
    })
    expect(point).toHaveBeenLastCalledWith('page-1', {
      box: { x: 10, y: 20, width: 30, height: 40 },
      label: 'This one',
      keep: false
    })
    await call('browser.point', { element: 'button#save', keep: true }, ctx)
    expect(point).toHaveBeenLastCalledWith('page-1', {
      selector: 'button#save',
      label: '',
      keep: true
    })
    await call('browser.point', { clear: true }, ctx)
    expect(point).toHaveBeenLastCalledWith('page-1', { clear: true, pointerId: undefined })
  })

  it('hands agent-browser only the locator forms its get box takes; the rest are CSS', async () => {
    const point = vi.fn(async () => ({ pointerId: 'p1', box: null, shown: true, cleared: 0 }))
    install({ point })
    const { ctx, runtime } = context()
    for (const element of ['@e3', 'text=Save', 'xpath=//button']) {
      runtime.browserElementBox.mockClear()
      await call('browser.point', { element }, ctx)
      expect(runtime.browserElementBox).toHaveBeenCalledTimes(1)
    }
    for (const element of ['role=button', 'label=Email', 'testid=save']) {
      runtime.browserElementBox.mockClear()
      await call('browser.point', { element }, ctx)
      expect(runtime.browserElementBox).not.toHaveBeenCalled()
      expect(point).toHaveBeenLastCalledWith('page-1', {
        selector: element,
        label: '',
        keep: false
      })
    }
  })

  it('refuses a point with neither an element nor a whole region', () => {
    const entry = methods.find((m) => m.name === 'browser.point')
    expect(entry?.params?.safeParse({ x: 1, y: 2 }).success).toBe(false)
    expect(entry?.params?.safeParse({ x: 1, y: 2, width: 3, height: 4 }).success).toBe(true)
  })
})
