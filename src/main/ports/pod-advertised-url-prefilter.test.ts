import { describe, expect, it } from 'vitest'
import { PtyBuffer } from './advertised-url-parsing'

// Pod: the "://" prefilter keeps every URL real servers print (bytes captured from Vite 7).
describe('advertised URL prefilter (Pod)', () => {
  it('still reads a coloured Vite URL', () => {
    const buffer = new PtyBuffer()
    const line =
      '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5999\x1b[22m/\x1b[39m\r\n'
    expect(buffer.ingest(line)).toContain('http://localhost:5999/')
  })

  it('still reads a plain Next URL', () => {
    expect(new PtyBuffer().ingest('   - Local:         http://localhost:3000\n')).toContain(
      'http://localhost:3000'
    )
  })

  it('skips a TUI frame with no scheme', () => {
    const frame =
      '\x1b[?2026h\x1b[2;1H\x1b[38;2;215;119;87m⏺ Read(src/app.ts): 12 lines, path ok\x1b[39m\r\n'
    expect(new PtyBuffer().ingest(frame)).toBe('')
  })
})
