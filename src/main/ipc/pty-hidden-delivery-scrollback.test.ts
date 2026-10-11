import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  rendererPtyViewDelivery,
  setDaemonQueryResponderConfirmed,
  setRendererPtyDeliveryInterest
} from './pty-hidden-delivery-gate'
import {
  exceedsMainTerminalModelScrollback,
  MAIN_TERMINAL_MODEL_SCROLLBACK_ROWS
} from './pty-hidden-delivery-scrollback'

describe('hidden delivery for panes deeper than main terminal model', () => {
  afterEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it("matches the rows main's model keeps", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    let data = ''
    for (let i = 1; i <= 8001; i += 1) {
      data += `line-${i}\r\n`
    }
    await emulator.write(data)
    const snapshot = emulator.getSnapshot({ scrollbackRows: 50_000 })
    const rows = `${snapshot.scrollbackAnsi ?? ''}${snapshot.snapshotAnsi}`.match(/line-\d+/g)
    emulator.dispose()
    expect(rows?.length).toBeGreaterThanOrEqual(MAIN_TERMINAL_MODEL_SCROLLBACK_ROWS)
    expect(rows?.length).toBeLessThan(MAIN_TERMINAL_MODEL_SCROLLBACK_ROWS + 24)
  })

  it('compares the configured depth, defaulting to the model depth', () => {
    expect(exceedsMainTerminalModelScrollback(undefined)).toBe(false)
    expect(exceedsMainTerminalModelScrollback({ terminalScrollbackRows: 5_000 })).toBe(false)
    expect(exceedsMainTerminalModelScrollback({ terminalScrollbackRows: 10_000 })).toBe(true)
  })

  it('keeps a deeper hidden sidecar pane parsing, and gates the rest as before', () => {
    const deep = { terminalScrollbackRows: 50_000 }
    markHiddenRendererPty('pty-1')
    expect(rendererPtyViewDelivery('pty-1', deep)).toBe('drop')
    setRendererPtyDeliveryInterest('pty-1', true)
    expect(rendererPtyViewDelivery('pty-1', deep)).toBe('parse')
    expect(rendererPtyViewDelivery('pty-1', { terminalScrollbackRows: 5_000 })).toBe('sidecarsOnly')
    // Why: until the daemon's take-back marker, the view must not parse bytes it answers.
    setDaemonQueryResponderConfirmed('pty-1', true)
    expect(rendererPtyViewDelivery('pty-1', deep)).toBe('sidecarsOnly')
  })
})
