import { describe, expect, it } from 'vitest'
import { TerminalQueryStripper, extractTerminalQuerySequences } from './terminal-query-stripper'

describe('TerminalQueryStripper', () => {
  it('removes queries and keeps everything else, returning the same string when nothing changed', () => {
    const stripper = new TerminalQueryStripper()
    const plain = 'plain \x1b[31mred\x1b[0m'
    expect(stripper.strip(plain)).toBe(plain)
    expect(stripper.strip('a\x1b[6nb\x1b]11;?\x07c\x1b[?2026hd')).toBe('abc\x1b[?2026hd')
  })

  it('holds a query torn across chunks and removes it whole', () => {
    const stripper = new TerminalQueryStripper()
    expect(stripper.strip('text\x1b[?20')).toBe('text')
    expect(stripper.strip('26$pmore')).toBe('more')
  })

  it('passes a torn state change on once it completes', () => {
    const stripper = new TerminalQueryStripper()
    expect(stripper.strip('a\x1b]11;')).toBe('a')
    expect(stripper.strip('#000000\x07b')).toBe('\x1b]11;#000000\x07b')
  })

  it('releases the held candidate as it is', () => {
    const stripper = new TerminalQueryStripper()
    stripper.strip('x\x1b[')
    expect(stripper.takeHeld()).toBe('\x1b[')
    expect(stripper.takeHeld()).toBe('')
  })
})

describe('extractTerminalQuerySequences', () => {
  it('lists the queries in output order', () => {
    expect(extractTerminalQuerySequences('a\x1b[6nb\x1b[31m\x1b[c')).toEqual(['\x1b[6n', '\x1b[c'])
  })
})
