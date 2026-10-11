import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

describe('CSI t window reports', () => {
  it('answers the text area in cells from the model, and no pixel report it has no view for', async () => {
    const onQueryReply = vi.fn()
    const emulator = new HeadlessEmulator({ cols: 100, rows: 30, onQueryReply })
    try {
      await emulator.write('\x1b[18t', { forwardQueryReplies: true })
      expect(onQueryReply.mock.calls.map((call) => call[0])).toEqual(['\x1b[8;30;100t'])
      emulator.resize(120, 40)
      await emulator.write('\x1b[18t\x1b[14t\x1b[16t', { forwardQueryReplies: true })
      expect(onQueryReply.mock.calls.map((call) => call[0])).toEqual([
        '\x1b[8;30;100t',
        '\x1b[8;40;120t'
      ])
    } finally {
      emulator.dispose()
    }
  })
})
