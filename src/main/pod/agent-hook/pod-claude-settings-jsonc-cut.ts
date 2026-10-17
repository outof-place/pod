// Fork-only (Pod): cutting one member or element out of JSONC text while every other byte, a user's
// comments included, stays where it was. The settings cut (pod-claude-settings-migration.ts) checks
// each result again: it parses, and it means the original minus what went.
import { findNodeAtLocation, type JSONPath, type Node } from 'jsonc-parser'

type Gap = { kind: 'blank' | 'comment' | 'comma'; start: number; end: number }

/** The text between two siblings, or a bracket and a member, as blanks, comments and commas; null
 *  for anything else. */
function gapParts(text: string, from: number, to: number): Gap[] | null {
  const parts: Gap[] = []
  for (let at = from; at < to;) {
    const start = at
    if (text[at] === ',') {
      at += 1
      parts.push({ kind: 'comma', start, end: at })
    } else if (text.startsWith('//', at)) {
      // Why up to the line break: the break is a blank, which ends the comment (\r or \n alone too).
      const line = text.slice(at, to).search(/[\r\n]/)
      at = line === -1 ? to : at + line
      parts.push({ kind: 'comment', start, end: at })
    } else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2)
      if (close === -1 || close + 2 > to) {
        return null
      }
      at = close + 2
      parts.push({ kind: 'comment', start, end: at })
    } else if (/\s/.test(text[at])) {
      while (at < to && /\s/.test(text[at])) {
        at += 1
      }
      parts.push({ kind: 'blank', start, end: at })
    } else {
      return null
    }
  }
  return parts
}

export function hasComment(text: string, node: Node): boolean {
  // Why the inside only: an emptied container's brackets hold nothing but blanks and comments.
  const parts = gapParts(text, node.offset + 1, node.offset + node.length - 1)
  return parts === null || parts.some((part) => part.kind === 'comment')
}

/** `text` without the member or element at `path`. Not jsonc-parser's modify: that rewrites the
 *  whitespace before a closing bracket. This cuts the node with one comma and the blanks beside
 *  it: the comma and blanks after it when it is not the last, else the blanks before it (never a
 *  `//` comment's line break) and the previous sibling's comma, or a trailing comma when it is the
 *  only one. Every other byte stays, a user's comment around it included. */
export function cutMember(text: string, root: Node, path: JSONPath): string | null {
  const node = findNodeAtLocation(root, path)
  const target = node?.parent?.type === 'property' ? node.parent : node
  const container = target?.parent
  const siblings = container?.children ?? []
  const index = target ? siblings.indexOf(target) : -1
  if (!target || !container || index === -1) {
    return null
  }
  const end = target.offset + target.length
  if (index < siblings.length - 1) {
    const parts = gapParts(text, end, siblings[index + 1].offset)
    const comma = parts?.findIndex((part) => part.kind === 'comma') ?? -1
    if (!parts || comma === -1) {
      return null
    }
    const before = parts.slice(0, comma).some((part) => part.kind === 'comment')
      ? text.slice(end, parts[comma].start)
      : ''
    const stop = parts[comma + 1]?.kind === 'blank' ? parts[comma + 1].end : parts[comma].end
    return text.slice(0, target.offset) + before + text.slice(stop)
  }
  const previous = index > 0 ? siblings[index - 1] : null
  const parts = gapParts(
    text,
    previous ? previous.offset + previous.length : container.offset + 1,
    target.offset
  )
  if (!parts) {
    return null
  }
  const last = parts.at(-1)
  let from = last?.kind === 'blank' ? last.start : target.offset
  const beforeLast = parts.at(-2)
  // Why: a `//` comment ends at its line break. When the entry's own line goes on after it (`]}`),
  // the blank's break has to stay, or what follows would be commented out.
  const lineGoesOn = !/^[^\S\r\n]*[\r\n]/.test(text.slice(end))
  if (
    lineGoesOn &&
    last?.kind === 'blank' &&
    beforeLast?.kind === 'comment' &&
    text.startsWith('//', beforeLast.start)
  ) {
    const lineBreak = /\r\n|\r|\n/.exec(text.slice(last.start, last.end))
    from = lineBreak ? last.start + lineBreak.index + lineBreak[0].length : last.end
  }
  if (!previous) {
    // The only member: a trailing comma after it goes too (`{"a": 1,}` would leave `{,}`).
    const after = gapParts(text, end, container.offset + container.length - 1)
    const trailing = after?.find((part) => part.kind === 'comma')
    return trailing
      ? text.slice(0, from) + text.slice(end, trailing.start) + text.slice(trailing.end)
      : text.slice(0, from) + text.slice(end)
  }
  const comma = parts.find((part) => part.kind === 'comma')
  if (!comma) {
    return null
  }
  return text.slice(0, comma.start) + text.slice(comma.end, from) + text.slice(end)
}
