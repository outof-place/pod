import { describe, expect, it } from 'vitest'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

describe('pane terminal window reports', () => {
  it('answers CSI 14, 16 and 18 t (text area px, cell px, text area cells) like Ghostty', () => {
    expect(buildDefaultTerminalOptions().windowOptions).toEqual({
      getWinSizePixels: true,
      getCellSizePixels: true,
      getWinSizeChars: true
    })
  })
})
