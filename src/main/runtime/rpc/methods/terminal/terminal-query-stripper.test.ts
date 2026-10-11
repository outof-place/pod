import { describe, expect, it } from 'vitest'
import { TerminalQueryStripper, extractTerminalQuerySequences } from './terminal-query-stripper'

describe('TerminalQueryStripper', () => {
  it('removes queries and keeps everything else, returning the same string when nothing changed', () => {
    const stripper = new TerminalQueryStripper()
    const plain = 'plain \x1b[31mred\x1b[0m'
    expect(stripper.process(plain, false)).toBe(plain)
    expect(stripper.process('a\x1b[6nb\x1b]11;?\x07c\x1b[?2026hd', false)).toBe('abc\x1b[?2026hd')
    const query = 'a\x1b[6nb'
    expect(stripper.process(query, true)).toBe(query)
  })

  it('holds a query torn across chunks and removes it whole', () => {
    const stripper = new TerminalQueryStripper()
    expect(stripper.process('text\x1b[?20', false)).toBe('text')
    expect(stripper.process('26$pmore', false)).toBe('more')
  })

  it('passes a torn state change on once it completes', () => {
    const stripper = new TerminalQueryStripper()
    expect(stripper.process('a\x1b]11;', false)).toBe('a')
    expect(stripper.process('#000000\x07b', true)).toBe('\x1b]11;#000000\x07b')
  })

  it('finishes a torn query for the view that got its start, though the election moved', () => {
    const owner = new TerminalQueryStripper()
    expect(owner.process('a\x1b[?20', true)).toBe('a\x1b[?20')
    expect(owner.process('26$pb', false)).toBe('26$pb')
    const other = new TerminalQueryStripper()
    expect(other.process('a\x1b[?20', false)).toBe('a')
    expect(other.process('26$pb\x1b[c', true)).toBe('b\x1b[c')
  })
})

describe('extractTerminalQuerySequences', () => {
  it('lists the queries in output order', () => {
    expect(extractTerminalQuerySequences('a\x1b[6nb\x1b[31m\x1b[c')).toEqual(['\x1b[6n', '\x1b[c'])
  })
})
