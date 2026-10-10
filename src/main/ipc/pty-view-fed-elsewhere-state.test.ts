import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyRendererPtyViewFedElsewhere,
  clearAllRendererPtyViewFedElsewhere,
  isRendererPtyViewFedElsewhere,
  requestRendererPtyViewFedElsewhere,
  setRendererPtyViewFedElsewhereQueueProbe
} from './pty-view-fed-elsewhere-state'

// Queued bytes keep the reply owner the fed-elsewhere set gave them at ingestion; these pin
// that the set refuses to flip while any bytes for the PTY are queued.
describe('parse-once fed-elsewhere state', () => {
  afterEach(() => {
    clearAllRendererPtyViewFedElsewhere()
    setRendererPtyViewFedElsewhereQueueProbe(() => false)
    vi.restoreAllMocks()
  })

  it('refuses a flip while bytes are queued and applies it once the queue drains', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let queued = true
    setRendererPtyViewFedElsewhereQueueProbe(() => queued)
    let settled = false
    // A caller that wrongly claims a batch boundary still cannot flip the set.
    const request = requestRendererPtyViewFedElsewhere('pty-1', true, true).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(isRendererPtyViewFedElsewhere('pty-1')).toBe(false)
    expect(settled).toBe(false)
    expect(applyRendererPtyViewFedElsewhere('pty-1')).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)

    queued = false
    expect(applyRendererPtyViewFedElsewhere('pty-1')).toBe(true)
    await request
    expect(isRendererPtyViewFedElsewhere('pty-1')).toBe(true)
  })

  it('settles a request that changes nothing even while bytes are queued', async () => {
    setRendererPtyViewFedElsewhereQueueProbe(() => true)
    await requestRendererPtyViewFedElsewhere('pty-2', false, true)
    expect(isRendererPtyViewFedElsewhere('pty-2')).toBe(false)
  })
})
