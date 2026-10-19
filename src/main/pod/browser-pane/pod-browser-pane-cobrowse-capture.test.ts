import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { captureScreenshot } from '../../browser/cdp-screenshot'
import { setPodBrowserPaneHooks } from './pod-browser-pane-hooks'
import {
  attach,
  fakeFrames,
  rendezvous,
  setup,
  texture
} from './pod-browser-pane-controller.test-support'

const markId = '3f1a9c2e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'
const markAt = {
  type: 'browserMarkAdd',
  pageId: 'page-1',
  markId,
  x: 180,
  y: 118,
  width: 0,
  height: 0
} as const

// The pane page as one-app runs it: captures hold its frames through the host's hook.
function paneWithHooks() {
  const frames = fakeFrames()
  const pane = setup(frames)
  setPodBrowserPaneHooks({
    agentCommand: vi.fn(),
    download: vi.fn(),
    openLink: vi.fn(() => false),
    passkey: vi.fn(() => null),
    holdFramesForCapture: (webContentsId) => pane.panes.holdFramesForCapture(webContentsId)
  })
  pane.panes.handle(rendezvous)
  pane.panes.handle(attach)
  return { frames, ...pane }
}

function markAnswers(onCapture: () => unknown) {
  return (method: string) => {
    switch (method) {
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 700 } }
      case 'DOM.getNodeForLocation':
        return { backendNodeId: 7, frameId: 'main' }
      case 'DOM.getBoxModel':
        return { model: { border: [100, 100, 260, 100, 260, 136, 100, 136] } }
      case 'Page.captureScreenshot':
        return onCapture()
      default:
        return {}
    }
  }
}

describe("a co-browse mark's screenshot on a pane page", () => {
  afterEach(() => {
    setPodBrowserPaneHooks(null)
  })

  // Chromium draws an offscreen page once at a clipped capture's size (176x52 for a mark: Electron 45,
  // _evidence/cobrowse/capture-probe); that frame reaching PodNative is shown as the whole page,
  // shrunk and centered, and a drag right after the mark misses it.
  it('keeps the frame drawn at the clip size off the pane and asks a fresh one after', async () => {
    const { frames, panes, wc } = paneWithHooks()
    const clipFrame = texture()
    let captured = false
    wc.cdp = markAnswers(() => {
      wc.emit('paint', { texture: clipFrame })
      captured = true
      return { data: 'iVBORw0KGgo=' }
    })
    panes.handle({ type: 'browserCobrowse', pageId: 'page-1', watch: true })
    panes.handle({ type: 'browserMarkMode', pageId: 'page-1', on: true })
    const askedBefore = wc.invalidate.mock.calls.length
    panes.handle(markAt)
    await vi.waitFor(() => expect(captured).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames.browserSend).not.toHaveBeenCalledWith(
      clipFrame.textureInfo.handle.ioSurface,
      expect.anything()
    )
    expect(wc.invalidate.mock.calls.length).toBeGreaterThan(askedBefore)
    // The page's own frames go out again once the capture is done.
    const next = texture()
    wc.emit('paint', { texture: next })
    expect(frames.browserSend).toHaveBeenCalledWith(
      next.textureInfo.handle.ioSurface,
      expect.anything()
    )
  })

  // An agent's screenshot can hold the page's turn for seconds (cdp-capture-settle.ts); the pane is
  // held only while the mark's own capture runs, not while it waits for its turn.
  it("keeps the pane live while the mark's capture waits for another capture's turn", async () => {
    const { frames, panes, wc } = paneWithHooks()
    let answerAgent: (value: unknown) => void = () => {}
    let captures = 0
    wc.cdp = markAnswers(() => {
      captures += 1
      return captures === 1
        ? new Promise((resolve) => {
            answerAgent = resolve
          })
        : { data: 'iVBORw0KGgo=' }
    })
    wc.debugger.attach()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the capture calls.
    const agent = captureScreenshot(wc as unknown as WebContents, { format: 'png' }, () => () => {})
    panes.handle({ type: 'browserCobrowse', pageId: 'page-1', watch: true })
    panes.handle({ type: 'browserMarkMode', pageId: 'page-1', on: true })
    panes.handle(markAt)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(captures).toBe(1)

    const live = texture()
    wc.emit('paint', { texture: live })
    expect(frames.browserSend).toHaveBeenCalledWith(
      live.textureInfo.handle.ioSurface,
      expect.anything()
    )

    answerAgent({ data: 'YWdlbnQ=' })
    await expect(agent).resolves.toEqual({ data: 'YWdlbnQ=' })
    await vi.waitFor(() => expect(captures).toBe(2))
  })
})
