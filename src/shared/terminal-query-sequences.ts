// Terminal output sequences that ask the terminal to answer (DA, DSR/CPR, DECRQM, XTVERSION,
// kitty flags, window reports, OSC colour/clipboard queries, XTGETTCAP, DECRQSS, kitty graphics
// queries), told apart from the state changes that share their introducers.

const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'
// A candidate longer than this is never a query; it is passed on as it is.
export const TERMINAL_QUERY_MAX_CANDIDATE_CHARS = 256

export type TerminalQueryScan =
  | { kind: 'query'; end: number }
  | { kind: 'other'; end: number }
  | { kind: 'partial' }

const WINDOW_REPORT_PARAMS = new Set([
  '11',
  '13',
  '13;2',
  '14',
  '14;2',
  '15',
  '16',
  '18',
  '19',
  '20',
  '21'
])

function isCsiQuery(prefix: string, params: string, intermediates: string, final: string): boolean {
  if (intermediates === '$') {
    // DECRQM (`CSI [?] Ps $ p`) and DECRQPSR (`CSI Ps $ w`).
    return (
      (final === 'p' && (prefix === '' || prefix === '?') && /^\d+$/.test(params)) || final === 'w'
    )
  }
  if (intermediates !== '') {
    return false
  }
  switch (final) {
    case 'c':
      return (
        (prefix === '' || prefix === '>' || prefix === '=') && (params === '' || params === '0')
      )
    case 'n':
      return (
        (prefix === '' && (params === '5' || params === '6')) ||
        (prefix === '?' && /^\d+(;\d+)*$/.test(params))
      )
    case 'q':
      return prefix === '>' && (params === '' || params === '0')
    case 'u':
      return prefix === '?' && params === ''
    case 't':
      return prefix === '' && WINDOW_REPORT_PARAMS.has(params)
    case 'm':
      return prefix === '?'
    case 'S':
      return prefix === '?' && ['1', '4'].includes(params.split(';')[1] ?? '')
    case 'x':
      return prefix === '' && (params === '' || params === '0' || params === '1')
    default:
      return false
  }
}

function scanCsi(data: string, start: number): TerminalQueryScan {
  let index = start + 2
  const first = data.charCodeAt(index)
  // `<`, `=`, `>` or `?` (0x3c-0x3f) opens a private parameter string.
  const prefix = first >= 0x3c && first <= 0x3f ? (data[index] ?? '') : ''
  if (prefix) {
    index += 1
  }
  const paramsStart = index
  // Digits, `:` and `;` (0x30-0x3b).
  while (index < data.length && data.charCodeAt(index) >= 0x30 && data.charCodeAt(index) <= 0x3b) {
    index += 1
  }
  const params = data.slice(paramsStart, index)
  const intermediatesStart = index
  while (index < data.length && (data.charCodeAt(index) & 0xf0) === 0x20) {
    index += 1
  }
  const intermediates = data.slice(intermediatesStart, index)
  if (index >= data.length) {
    return index - start > TERMINAL_QUERY_MAX_CANDIDATE_CHARS
      ? { kind: 'other', end: start + 1 }
      : { kind: 'partial' }
  }
  const code = data.charCodeAt(index)
  if (code < 0x40 || code > 0x7e) {
    return { kind: 'other', end: start + 1 }
  }
  return isCsiQuery(prefix, params, intermediates, data[index] ?? '')
    ? { kind: 'query', end: index + 1 }
    : { kind: 'other', end: index + 1 }
}

function oscBodyIsQuery(command: number, body: string): boolean {
  const parts = body.split(';')
  if (command === 4 || command === 5) {
    return parts.some((part, index) => index % 2 === 1 && part === '?')
  }
  if (command >= 10 && command <= 19) {
    return parts.includes('?')
  }
  if (command === 52) {
    return parts[1] === '?'
  }
  // Kitty desktop notifications: `p=?` asks what the terminal supports.
  return command === 99 && /(?:^|:)p=\?(?::|$)/.test(parts[0] ?? '')
}

/** The end of an ST/BEL-terminated string body from `from`, or -1 while it is still open. */
function stringEnd(
  data: string,
  from: number,
  allowBel: boolean
): { end: number; bodyEnd: number } | null {
  for (let index = from; index < data.length; index += 1) {
    if (allowBel && data[index] === BEL) {
      return { end: index + 1, bodyEnd: index }
    }
    if (data[index] === ESC) {
      return data.startsWith(ST, index)
        ? { end: index + 2, bodyEnd: index }
        : { end: index, bodyEnd: index }
    }
  }
  return null
}

function scanOsc(data: string, start: number): TerminalQueryScan {
  const commandMatch = /^\d+/.exec(data.slice(start + 2, start + 8))
  const afterCommand = start + 2 + (commandMatch?.[0].length ?? 0)
  if (afterCommand >= data.length) {
    return { kind: 'partial' }
  }
  const command = Number(commandMatch?.[0] ?? Number.NaN)
  if (
    data[afterCommand] !== ';' ||
    ![4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 52, 99].includes(command)
  ) {
    return { kind: 'other', end: start + 2 }
  }
  const terminated = stringEnd(data, afterCommand + 1, true)
  if (!terminated) {
    return data.length - start > TERMINAL_QUERY_MAX_CANDIDATE_CHARS
      ? { kind: 'other', end: start + 2 }
      : { kind: 'partial' }
  }
  return oscBodyIsQuery(command, data.slice(afterCommand + 1, terminated.bodyEnd))
    ? { kind: 'query', end: terminated.end }
    : { kind: 'other', end: start + 2 }
}

function scanStringQuery(
  data: string,
  start: number,
  introducers: readonly string[],
  isQuery: (body: string) => boolean
): TerminalQueryScan {
  const head = data.slice(start + 2, start + 4)
  if (head.length < 2 && introducers.some((introducer) => introducer.startsWith(head))) {
    return { kind: 'partial' }
  }
  if (!introducers.some((introducer) => head.startsWith(introducer))) {
    return { kind: 'other', end: start + 2 }
  }
  const terminated = stringEnd(data, start + 2, false)
  if (!terminated) {
    return data.length - start > TERMINAL_QUERY_MAX_CANDIDATE_CHARS
      ? { kind: 'other', end: start + 2 }
      : { kind: 'partial' }
  }
  return isQuery(data.slice(start + 2, terminated.bodyEnd))
    ? { kind: 'query', end: terminated.end }
    : { kind: 'other', end: start + 2 }
}

/** Classifies the escape sequence at `start` (which must be an ESC). */
export function scanTerminalQuery(data: string, start: number): TerminalQueryScan {
  if (start + 1 >= data.length) {
    return { kind: 'partial' }
  }
  switch (data[start + 1]) {
    case '[':
      return scanCsi(data, start)
    case ']':
      return scanOsc(data, start)
    case 'P':
      // XTGETTCAP (`DCS + q`) and DECRQSS (`DCS $ q`).
      return scanStringQuery(data, start, ['+q', '$q'], () => true)
    case '_':
      // A kitty graphics query (`a=q`); other graphics commands change state.
      return scanStringQuery(
        data,
        start,
        ['G'],
        (body) => body.slice(1).split(';')[0]?.split(',').includes('a=q') === true
      )
    default:
      return { kind: 'other', end: start + 1 }
  }
}
