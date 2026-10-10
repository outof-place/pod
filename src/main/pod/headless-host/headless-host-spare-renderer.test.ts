import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, WebContentsView: vi.fn(), webContents: {} }))

import {
  SPARE_RENDERER_RELEASE_DELAY_MS,
  releaseStartupSpareRenderer,
  schedulePodHeadlessSpareRendererRelease,
  type SpareRendererPorts
} from './headless-host-spare-renderer'
import type { PodHeadlessHostCuts } from './headless-host-mode'

function ports(liveWebContents: number, renderers: number): SpareRendererPorts & { taken: number } {
  const state = {
    taken: 0,
    liveWebContentsCount: () => liveWebContents,
    rendererProcessCount: () => renderers,
    takeAndClose: () => {
      state.taken += 1
    }
  }
  return state
}

const CUTS: PodHeadlessHostCuts = {
  dropWebSocket: true,
  releaseSpareRenderer: true,
  inProcessGpu: false,
  inProcessNetwork: false
}

describe('Pod headless host spare renderer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes the spare only while no page exists', () => {
    const idle = ports(0, 1)
    expect(releaseStartupSpareRenderer(idle)).toBe(true)
    expect(idle.taken).toBe(1)
    // Why: with a page open, a renderer may be that page's, and the spare may serve its next one.
    const withPage = ports(1, 2)
    expect(releaseStartupSpareRenderer(withPage)).toBe(false)
    const noSpare = ports(0, 0)
    expect(releaseStartupSpareRenderer(noSpare)).toBe(false)
    expect(withPage.taken + noSpare.taken).toBe(0)
  })

  it('releases once startup has settled, and not when the host keeps it', () => {
    vi.useFakeTimers()
    const released = ports(0, 1)
    schedulePodHeadlessSpareRendererRelease(CUTS, released)
    const kept = ports(0, 1)
    schedulePodHeadlessSpareRendererRelease({ ...CUTS, releaseSpareRenderer: false }, kept)
    const outside = ports(0, 1)
    schedulePodHeadlessSpareRendererRelease(null, outside)
    vi.advanceTimersByTime(SPARE_RENDERER_RELEASE_DELAY_MS - 1)
    expect(released.taken).toBe(0)
    vi.advanceTimersByTime(1)
    expect([released.taken, kept.taken, outside.taken]).toEqual([1, 0, 0])
  })
})
