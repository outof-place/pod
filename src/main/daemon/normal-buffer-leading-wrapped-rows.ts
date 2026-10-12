import type { Terminal } from '@xterm/headless'
import type { TerminalSnapshot } from './terminal-snapshot'

/**
 * The rows a snapshot's normal buffer opens with that continue a line the buffer no longer holds.
 *
 * A reflow to a narrower grid wraps every line over more rows and the scrollback limit then trims
 * the oldest of them, which can cut a line after its first rows. Only for a snapshot serialized
 * from the buffer's first row, the one `scrollbackLines` counts from.
 */
export function leadingWrappedRowsField(
  terminal: Terminal,
  scrollbackRows: number | undefined
): Pick<TerminalSnapshot, 'leadingWrappedRows'> {
  const normal = terminal.buffer.normal
  if (scrollbackRows !== undefined && scrollbackRows + terminal.rows < normal.length) {
    return {}
  }
  let rows = 0
  while (rows < normal.length && normal.getLine(rows)?.isWrapped === true) {
    rows += 1
  }
  return rows > 0 ? { leadingWrappedRows: rows } : {}
}
