import { scanTerminalQuery } from '../../../../../shared/terminal-query-sequences'

/** One view's output with its queries removed, so a view that is not the elected responder has
 *  nothing to answer. A query belongs to the view that was responder at its first byte: one torn
 *  across chunks is finished for that view and kept from the other, however the election moves. */
export class TerminalQueryStripper {
  // The candidate torn at the last chunk end, and whether this view got its first bytes.
  private torn: { text: string; passed: boolean } | null = null

  /** This view's share of `data`: as it is while it answers, without queries otherwise. */
  process(data: string, responder: boolean): string {
    const torn = this.torn
    if (!torn) {
      return this.scan(data, responder)
    }
    this.torn = null
    const candidate = torn.text + data
    const scan = scanTerminalQuery(candidate, 0)
    if (scan.kind === 'partial') {
      this.torn = { text: candidate, passed: torn.passed }
      return torn.passed ? data : ''
    }
    if (scan.kind === 'query') {
      const rest = data.slice(scan.end - torn.text.length)
      return (
        (torn.passed ? data.slice(0, data.length - rest.length) : '') + this.scan(rest, responder)
      )
    }
    // Not a query after all: the held bytes go out now, ahead of the rest.
    return torn.passed ? this.scan(data, responder) : this.scan(candidate, responder)
  }

  private scan(input: string, responder: boolean): string {
    let output = ''
    let from = 0
    let index = input.indexOf('\x1b')
    while (index !== -1) {
      const scan = scanTerminalQuery(input, index)
      if (scan.kind === 'partial') {
        this.torn = { text: input.slice(index), passed: responder }
        return responder ? input : output + input.slice(from, index)
      }
      if (scan.kind === 'query' && !responder) {
        output += input.slice(from, index)
        from = scan.end
      }
      index = input.indexOf('\x1b', scan.end)
    }
    return from === 0 ? input : output + input.slice(from)
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
