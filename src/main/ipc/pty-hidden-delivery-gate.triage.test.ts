// Triage repro for stablyai/orca#27033 review finding (a): a hidden pane whose PTY has a sidecar
// (delivery interest) is now view-gated, so reveal restores from main's model, which keeps only
// its own 5,000-row scrollback. A pane configured for 50,000 rows that held 8,001 rows loses history.
import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  rendererPtyViewDelivery,
  setRendererPtyDeliveryInterest
} from './pty-hidden-delivery-gate'

describe('#27033 triage: sidecar interest gates the view, reveal restores from the model', () => {
  afterEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('hidden PTY with a sidecar is view-gated (restore from model on reveal)', () => {
    markHiddenRendererPty('pty-1')
    setRendererPtyDeliveryInterest('pty-1', true)
    // Before #27033 interest suppressed the gate ('parse'); the view kept its own scrollback.
    expect(rendererPtyViewDelivery('pty-1', {})).toBe('sidecarsOnly')
  })

  it('(a) model restore keeps the 8,001 rows a 50,000-row pane retained', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    let data = ''
    for (let i = 1; i <= 8001; i += 1) {
      data += `line-${i}\r\n`
    }
    await emulator.write(data)
    // Renderer asks for the pane's configured depth (resolveHiddenRestoreScrollbackRows).
    const snapshot = emulator.getSnapshot({ scrollbackRows: 50_000 })
    const text = `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi}`
    const rows = text.match(/line-\d+/g)?.length ?? 0
    emulator.dispose()
    // Bug: main's emulator is built with DEFAULT_SCROLLBACK 5000, so ~5,0xx rows come back and the
    // replay clears the renderer's fuller history first.
    expect(rows).toBeGreaterThanOrEqual(8001)
  })
})
