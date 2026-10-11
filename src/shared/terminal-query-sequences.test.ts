import { describe, expect, it } from 'vitest'
import { scanTerminalQuery } from './terminal-query-sequences'

const kind = (sequence: string): string => scanTerminalQuery(sequence, 0).kind

describe('scanTerminalQuery', () => {
  it('finds the queries Claude Code and other TUIs send', () => {
    for (const query of [
      '\x1b[c',
      '\x1b[0c',
      '\x1b[>c',
      '\x1b[=c',
      '\x1b[5n',
      '\x1b[6n',
      '\x1b[?6n',
      '\x1b[?996n',
      '\x1b[?2026$p',
      '\x1b[4$p',
      '\x1b[>0q',
      '\x1b[>q',
      '\x1b[?u',
      '\x1b[14t',
      '\x1b[16t',
      '\x1b[18t',
      '\x1b[14;2t',
      '\x1b]4;1;?\x07',
      '\x1b]4;0;rgb:00/00/00;1;?\x1b\\',
      '\x1b]10;?\x07',
      '\x1b]11;?\x1b\\',
      '\x1b]12;?\x07',
      '\x1b]10;?;?\x07',
      '\x1b]52;c;?\x07',
      '\x1b]99;i=n:p=?;\x1b\\',
      '\x1bP+q544e\x1b\\',
      '\x1bP$qm\x1b\\',
      '\x1b_Gi=31,a=q;AAAA\x1b\\'
    ]) {
      expect({ query, kind: kind(query) }).toEqual({ query, kind: 'query' })
    }
  })

  it('leaves the state changes that share their introducers', () => {
    for (const change of [
      '\x1b[>1u',
      '\x1b[<u',
      '\x1b[=1;1u',
      '\x1b[8;40;120t',
      '\x1b[22;0t',
      '\x1b[2 q',
      '\x1b[?2026h',
      '\x1b[1;5R',
      '\x1b[31m',
      '\x1b]4;1;rgb:ff/00/00\x07',
      '\x1b]11;#000000\x07',
      '\x1b]52;c;aGk=\x07',
      '\x1b]0;title\x07',
      '\x1b]8;;https://example.com\x1b\\',
      '\x1bPq#0;2;0;0;0\x1b\\',
      '\x1b_Gi=31,a=T;AAAA\x1b\\',
      '\x1b7'
    ]) {
      expect({ change, kind: kind(change) }).toEqual({ change, kind: 'other' })
    }
  })

  it('waits for a candidate torn at the end of a chunk', () => {
    for (const torn of [
      '\x1b',
      '\x1b[',
      '\x1b[?20',
      '\x1b]1',
      '\x1b]11;?',
      '\x1bP+q54',
      '\x1b_Gi=1,a=q'
    ]) {
      expect({ torn, kind: kind(torn) }).toEqual({ torn, kind: 'partial' })
    }
  })

  it('reports where a query ends', () => {
    expect(scanTerminalQuery('ab\x1b[6ncd', 2)).toEqual({ kind: 'query', end: 6 })
    expect(scanTerminalQuery('\x1b]11;?\x07rest', 0)).toEqual({ kind: 'query', end: 7 })
  })
})
