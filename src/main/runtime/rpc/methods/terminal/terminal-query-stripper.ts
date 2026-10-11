import { scanTerminalQuery } from '../../../../../shared/terminal-query-sequences'

/** One view's output with its queries removed, so a view that is not the elected responder has
 *  nothing to answer. A candidate torn at a chunk end waits for the next chunk. */
export class TerminalQueryStripper {
  private held = ''

  strip(data: string): string {
    const input = this.held + data
    this.held = ''
    let output = ''
    let from = 0
    let index = input.indexOf('\x1b')
    while (index !== -1) {
      const scan = scanTerminalQuery(input, index)
      if (scan.kind === 'partial') {
        this.held = input.slice(index)
        return output + input.slice(from, index)
      }
      if (scan.kind === 'query') {
        output += input.slice(from, index)
        from = scan.end
      }
      index = input.indexOf('\x1b', scan.end)
    }
    return from === 0 ? input : output + input.slice(from)
  }

  /** The torn candidate, released as it is when this view starts answering. */
  takeHeld(): string {
    const held = this.held
    this.held = ''
    return held
  }
}

/** The query sequences in `data`, in order, for the responder's detach fallback. */
export function extractTerminalQuerySequences(data: string): string[] {
  const queries: string[] = []
  let index = data.indexOf('\x1b')
  while (index !== -1) {
    const scan = scanTerminalQuery(data, index)
    if (scan.kind === 'partial') {
      break
    }
    if (scan.kind === 'query') {
      queries.push(data.slice(index, scan.end))
    }
    index = data.indexOf('\x1b', scan.end)
  }
  return queries
}
