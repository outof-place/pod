// Parse once: xterm skips a main-fed pane's bytes, yet Orca's paste (bracketed or not) and any
// key xterm encodes read xterm's own input modes. These are the DEC private modes that change
// what xterm sends; only their set/reset sequences, and the resets that clear them, reach xterm.
const INPUT_MODES = new Set([
  1, // application cursor keys
  9, // X10 mouse reporting
  66, // application keypad
  1000, // mouse reporting and its encodings
  1002,
  1003,
  1004, // focus reporting
  1005,
  1006,
  1015,
  1016,
  2004 // bracketed paste
])

const ESCAPE = '\u001b'
// What follows an ESC in `ESC [ ? params h|l`.
const PRIVATE_MODE_AFTER_ESCAPE_RE = /^\[\?([\d;]*)([hl])/
// RIS (`ESC c`), DECSTR (`ESC [ ! p`), and DECKPAM/DECKPNM (`ESC =`, `ESC >`).
const RESET_AFTER_ESCAPE_RE = /^(?:c|=|>|\[!p)/
// An unterminated start of either.
const SEQUENCE_PREFIX_RE = /^(?:\[(?:\?[\d;]*|!)?)?$/
// Longest unterminated `ESC [ ? params` worth carrying into the next chunk.
const MAX_TAIL = 64

export type InputModeScan = { sequences: string; tail: string }

// The input-mode sequences in `tail + data`, rebuilt with only those modes, and the
// unterminated sequence (if any) at the end, for the next chunk.
export function scanInputModeSequences(data: string, tail: string): InputModeScan {
  const text = tail + data
  let sequences = ''
  let pending = ''
  for (
    let escape = text.indexOf(ESCAPE);
    escape !== -1;
    escape = text.indexOf(ESCAPE, escape + 1)
  ) {
    const rest = text.slice(escape + 1, escape + 1 + MAX_TAIL)
    const mode = PRIVATE_MODE_AFTER_ESCAPE_RE.exec(rest)
    const reset = mode ? null : RESET_AFTER_ESCAPE_RE.exec(rest)
    if (mode) {
      const modes = mode[1]
        .split(';')
        .filter((param) => param !== '' && INPUT_MODES.has(Number(param)))
      if (modes.length > 0) {
        sequences += `${ESCAPE}[?${modes.join(';')}${mode[2]}`
      }
    } else if (reset) {
      sequences += ESCAPE + reset[0]
    } else if (escape + 1 + rest.length === text.length && SEQUENCE_PREFIX_RE.test(rest)) {
      pending = text.slice(escape)
    }
  }
  return { sequences, tail: pending }
}
