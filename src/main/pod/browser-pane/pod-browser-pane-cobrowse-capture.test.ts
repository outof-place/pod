import { describe, expect, it, vi } from 'vitest'
import {
  attach,
  fakeFrames,
  rendezvous,
  setup,
  texture
} from './pod-browser-pane-controller.test-support'

const markId = '3f1a9c2e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'

describe("a co-browse mark's screenshot on a pane page", () => {
  // Chromium draws an offscreen page once at a clipped capture's size (176x52 for a mark: Electron 45,
  // _evidence/cobrowse/capture-probe); that frame reaching PodNative is shown as the whole page,
  // shrunk and centered, and a drag right after the mark misses it.
  it('keeps the frame drawn at the clip size off the pane and asks a fresh one after', async () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames)
    panes.handle(rendezvous)
    panes.handle(attach)
    const clipFrame = texture()
    let captured = false
    wc.cdp = (method) => {
      switch (method) {
        case 'Page.getLayoutMetrics':
          return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 700 } }
        case 'DOM.getNodeForLocation':
          return { backendNodeId: 7, frameId: 'main' }
        case 'DOM.getBoxModel':
          return { model: { border: [100, 100, 260, 100, 260, 136, 100, 136] } }
        case 'Page.captureScreenshot':
          wc.emit('paint', { texture: clipFrame })
          captured = true
          return { data: 'iVBORw0KGgo=' }
        default:
          return {}
      }
    }
    panes.handle({ type: 'browserCobrowse', pageId: 'page-1', watch: true })
    panes.handle({ type: 'browserMarkMode', pageId: 'page-1', on: true })
    const askedBefore = wc.invalidate.mock.calls.length
    panes.handle({
      type: 'browserMarkAdd',
      pageId: 'page-1',
      markId,
      x: 180,
      y: 118,
      width: 0,
      height: 0
    })
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
})
