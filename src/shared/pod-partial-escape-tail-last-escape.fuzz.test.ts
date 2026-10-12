import { describe, expect, it } from 'vitest'
import { classifyTerminalEscapeIntroducer } from './terminal-escape-introducer'
import {
  advancePartialEscapeTail,
  extractPartialEscapeTail,
  MAX_PARTIAL_ESCAPE_TAIL_LENGTH
} from './terminal-partial-escape-tail'

// Pod: the last-ESC shortcut in extractPartialEscapeTail against the full walk it replaced
// (verbatim below), on every string up to depth 4 and on random sequence soups.

type ScanState =
  | 'ground'
  | 'esc'
  | 'escIntermediate'
  | 'csi'
  | 'osc'
  | 'oscEsc'
  | 'string'
  | 'stringEsc'

const ESC = 0x1b
const CAN = 0x18
const SUB = 0x1a
const BEL = 0x07

/** ESC-state transition shared by the fresh-ESC and abort-reprocess paths. */
function stateAfterEscByte(code: number): ScanState {
  switch (classifyTerminalEscapeIntroducer(code)) {
    case 'csi':
      return 'csi'
    case 'osc':
      return 'osc'
    case 'string':
      return 'string'
    case 'intermediate':
      return 'escIntermediate'
    case 'execute':
      return 'esc' // the ESC is still pending; a further ESC arrives via the callers
    case 'final':
      return 'ground'
  }
}

function fullWalkExtract(stream: string): string {
  let state: ScanState = 'ground'
  let start = 0
  for (let i = 0; i < stream.length; i++) {
    if (state === 'ground') {
      // Only ESC leaves ground; skip ordinary text without a per-code-unit walk.
      // Check the current unit first: on dense escape streams it is usually the
      // ESC itself, and indexOf's call + SIMD setup costs more than the compare.
      const escape = stream.charCodeAt(i) === ESC ? i : stream.indexOf('\x1b', i)
      if (escape === -1) {
        return ''
      }
      start = escape
      i = escape
      state = 'esc'
      continue
    }
    const code = stream.charCodeAt(i)
    if (
      code === ESC &&
      state !== 'osc' &&
      state !== 'string' &&
      state !== 'oscEsc' &&
      state !== 'stringEsc'
    ) {
      // ESC aborts a pending ESC/CSI sequence and starts a new one.
      start = i
      state = 'esc'
      continue
    }
    // CAN/SUB abort an in-progress escape sequence back to ground in every
    // non-string state (xterm's VT500 parser). The csi/osc/string cases handle
    // this inline below; esc/escIntermediate must too, or `ESC CAN` and
    // `ESC <intermediate> CAN` leave a bogus tail instead of dropping to ground.
    if ((code === CAN || code === SUB) && (state === 'esc' || state === 'escIntermediate')) {
      state = 'ground'
      continue
    }
    switch (state) {
      case 'esc':
        state = stateAfterEscByte(code)
        break
      case 'escIntermediate':
        if (code >= 0x30 && code <= 0x7e) {
          state = 'ground'
        }
        // 0x20–0x2f stays; other C0 executes and stays (CAN/SUB handled above).
        break
      case 'csi':
        if (code === CAN || code === SUB) {
          state = 'ground'
        } else if (code >= 0x40 && code <= 0x7e) {
          state = 'ground' // final byte completes the CSI
        }
        // params/intermediates (0x20–0x3f), C0, DEL stay in-sequence.
        break
      case 'osc':
        if (code === BEL || code === CAN || code === SUB) {
          state = 'ground'
        } else if (code === ESC) {
          state = 'oscEsc'
        }
        break
      case 'oscEsc':
        if (code === 0x5c) {
          state = 'ground' // ESC \ = ST terminates the OSC
        } else {
          // The ESC aborted the OSC and opened a new sequence at i-1 — except a
          // second ESC starts its own sequence at i, and CAN/SUB abort to ground.
          start = code === ESC ? i : i - 1
          state =
            code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code)
        }
        break
      case 'string':
        if (code === CAN || code === SUB) {
          state = 'ground'
        } else if (code === ESC) {
          state = 'stringEsc'
        }
        break
      case 'stringEsc':
        if (code === 0x5c) {
          state = 'ground'
        } else {
          start = code === ESC ? i : i - 1
          state =
            code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code)
        }
        break
    }
  }
  // ESC already ends a string in xterm; replay only its pending escape state.
  if (state === 'oscEsc' || state === 'stringEsc') {
    return '\x1b'
  }
  return state === 'ground' ? '' : stream.slice(start)
}

const ALPHABET = [
  '\x1b',
  '\x18',
  '\x1a',
  '\x07',
  '\x00',
  '\\',
  '[',
  ']',
  'P',
  '_',
  '(',
  ' ',
  '0',
  ';',
  'm',
  '\n',
  'é'
]
const SEQUENCES = [
  '\x1b[1;31m',
  '\x1b]0;my title\x07',
  '\x1b]8;;https://example.com\x1b\\',
  '\x1bPq#0;2;0;0;0#0!6~\x1b\\',
  '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\',
  '\x1b[?2026h',
  '\x1b(B',
  '\x1b]0;title\x18rest',
  '\x1bPx\x1b\x18X0abc',
  '\x1b] \x1b\x1b^',
  '\x1bPq\x1b\x1b]0;x\x07',
  'plain text ',
  '\r\n'
]

function* stringsUpTo(maxDepth: number): Generator<string> {
  yield ''
  for (let depth = 1; depth <= maxDepth; depth++) {
    const digits = Array.from({ length: depth }, () => 0)
    for (;;) {
      yield digits.map((digit) => ALPHABET[digit]).join('')
      let place = depth - 1
      while (place >= 0 && ++digits[place] === ALPHABET.length) {
        digits[place--] = 0
      }
      if (place < 0) {
        break
      }
    }
  }
}

function soup(seed: number, parts: number): string {
  let state = seed
  let text = ''
  for (let i = 0; i < parts; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const pick = state % (SEQUENCES.length + ALPHABET.length)
    const part = pick < SEQUENCES.length ? SEQUENCES[pick]! : ALPHABET[pick - SEQUENCES.length]!
    // Cut sequences at random points so tails end in every state.
    text += state % 7 === 0 ? part.slice(0, state % (part.length + 1)) : part
  }
  return text
}

const oracleAdvance = (pending: string, chunk: string): string => {
  const tail = fullWalkExtract(pending + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}

describe('extractPartialEscapeTail last-ESC shortcut (Pod)', () => {
  it('equals the full walk on every string up to depth 4', () => {
    let checked = 0
    for (const text of stringsUpTo(4)) {
      checked++
      if (extractPartialEscapeTail(text) !== fullWalkExtract(text)) {
        expect.fail(`diverged: ${JSON.stringify(text)}`)
      }
    }
    expect(checked).toBeGreaterThan(80_000)
  })

  it('equals the full walk, folded or whole, on random sequence soups', () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const text = soup(seed, 1 + (seed % 40))
      expect(extractPartialEscapeTail(text)).toBe(fullWalkExtract(text))
      const cut = seed % (text.length + 1)
      const pending = fullWalkExtract(text.slice(0, cut))
      expect(advancePartialEscapeTail(pending, text.slice(cut))).toBe(
        oracleAdvance(pending, text.slice(cut))
      )
    }
  })

  it('keeps the cap: an over-long OSC is abandoned the same way', () => {
    const long = `\x1b]0;${'x'.repeat(MAX_PARTIAL_ESCAPE_TAIL_LENGTH + 10)}`
    expect(advancePartialEscapeTail('', long)).toBe(oracleAdvance('', long))
    expect(advancePartialEscapeTail('\x1b]0;', 'x'.repeat(5000))).toBe(
      oracleAdvance('\x1b]0;', 'x'.repeat(5000))
    )
  })
})
