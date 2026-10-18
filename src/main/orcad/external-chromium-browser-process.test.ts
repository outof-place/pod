import { beforeEach, describe, expect, it, vi } from 'vitest'

const { start, stop, initialize, clear, run, selectPage, resolveTargetPage, describePage } =
  vi.hoisted(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    initialize: vi.fn(),
    clear: vi.fn(),
    run: vi.fn(),
    selectPage: vi.fn(),
    resolveTargetPage: vi.fn(),
    describePage: vi.fn()
  }))
vi.mock('./external-chromium-browser-session', () => ({
  ExternalChromiumBrowserSession: class {
    start = start
    stop = stop
    run = run
    selectPage = selectPage
  }
}))
vi.mock('./external-chromium-tab-registry', () => ({
  ExternalChromiumTabRegistry: class {
    initialize = initialize
    clear = clear
    resolveTargetPage = resolveTargetPage
    describePage = describePage
  }
}))

import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'

describe('external Chromium startup cancellation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('does not publish a session that resolves after cancellation and permits cleanup', async () => {
    const controller = new AbortController()
    start.mockImplementation(async () => {
      controller.abort()
      return 'tab-live'
    })
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/orca/agent-browser',
      { executablePath: '/opt/orca/chromium', provider: 'chromium' },
      '/state'
    )
    await expect(browser.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledWith(controller.signal)
    expect(initialize).not.toHaveBeenCalled()
    expect(browser.isAvailable()).toBe(false)
    await browser.stop()
    expect(stop).toHaveBeenCalledWith()
    expect(clear).toHaveBeenCalledOnce()
  })
})

describe('external Chromium snapshot options', () => {
  beforeEach(() => vi.resetAllMocks())

  it('narrows the snapshot the way the agent asked', async () => {
    resolveTargetPage.mockResolvedValue({ publicPageId: 'page-1', agentPageId: 't1' })
    describePage.mockResolvedValue({ url: 'https://example.test/', title: 'Example' })
    run.mockResolvedValue({ snapshot: '- button "Go" [ref=e1]', refs: {} })
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/orca/agent-browser',
      { executablePath: '/opt/orca/chromium', provider: 'chromium' },
      '/state'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commands proxy only reads the host it is handed through to mocked collaborators.
    const commands = browser.createCommands({} as Parameters<typeof browser.createCommands>[0])

    await commands.browserSnapshot({
      page: 'page-1',
      interactive: true,
      depth: 2,
      selector: '#app'
    })

    expect(run).toHaveBeenCalledWith(['snapshot', '-i', '-d', '2', '-s', '#app'])
  })

  it('sends no -d for a depth agent-browser would reject', async () => {
    resolveTargetPage.mockResolvedValue({ publicPageId: 'page-1', agentPageId: 't1' })
    describePage.mockResolvedValue({ url: 'https://example.test/', title: 'Example' })
    run.mockResolvedValue({ snapshot: '- button "Go" [ref=e1]', refs: {} })
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/orca/agent-browser',
      { executablePath: '/opt/orca/chromium', provider: 'chromium' },
      '/state'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commands proxy only reads the host it is handed through to mocked collaborators.
    const commands = browser.createCommands({} as Parameters<typeof browser.createCommands>[0])

    await commands.browserSnapshot({ page: 'page-1', depth: 0 })

    expect(run).toHaveBeenCalledWith(['snapshot'])
  })
})

describe('external Chromium viewport reset', () => {
  beforeEach(() => vi.resetAllMocks())

  it('says a reset is unavailable instead of sending an empty viewport', async () => {
    resolveTargetPage.mockResolvedValue({ publicPageId: 'page-1', agentPageId: 't1' })
    run.mockResolvedValue({})
    const browser = new ExternalChromiumBrowserProcess(
      '/opt/orca/agent-browser',
      { executablePath: '/opt/orca/chromium', provider: 'chromium' },
      '/state'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commands proxy only reads the host it is handed through to mocked collaborators.
    const commands = browser.createCommands({} as Parameters<typeof browser.createCommands>[0])

    await expect(
      commands.browserSetViewport({ page: 'page-1', reset: true })
    ).rejects.toMatchObject({ code: 'browser_command_unavailable' })
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(['viewport']))
  })
})
