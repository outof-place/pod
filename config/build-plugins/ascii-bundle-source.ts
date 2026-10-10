import type { Plugin, Rollup } from 'vite'

// Why: Electron keeps the main entry script's source in the heap twice, and any non-ASCII code
// unit makes both copies two-byte: index.js (9.6M chars) held 2 x 18.2 MiB instead of 2 x 9.1.

type TextRange = { start: number; end: number }
type LineEdit = { column: number; delta: number }

/**
 * Whether escaping makes the source smaller in memory. A script Electron or Node runs as its main
 * file is kept two-byte for any non-ASCII; a required chunk only for code units above U+00FF.
 * Each escape costs 5 more characters, so a mostly non-ASCII chunk (a Japanese catalog) stays.
 */
export function shouldRewriteToAscii(code: string, isEntry: boolean): boolean {
  let nonAscii = 0
  let aboveLatin1 = false
  for (let index = 0; index < code.length; index++) {
    const unit = code.charCodeAt(index)
    if (unit > 0x7f) {
      nonAscii++
      aboveLatin1 ||= unit > 0xff
    }
  }
  return (isEntry ? nonAscii > 0 : aboveLatin1) && nonAscii * 5 < code.length
}

function unicodeEscape(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, '0')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTextRange(value: unknown): value is TextRange {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number'
}

/** Text ranges (UTF-16 offsets) of every tagged template's literal parts. */
export function collectTaggedTemplateText(ast: unknown): TextRange[] {
  const ranges: TextRange[] = []
  const stack: unknown[] = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    if (!isRecord(node)) {
      continue
    }
    if (node.type === 'TaggedTemplateExpression' && isRecord(node.quasi)) {
      const quasis = Array.isArray(node.quasi.quasis) ? node.quasi.quasis : []
      ranges.push(...quasis.filter(isTextRange).map(({ start, end }) => ({ start, end })))
    }
    for (const key in node) {
      if (isRecord(node[key])) {
        stack.push(node[key])
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}

export type AsciiRewrite = {
  code: string
  /** Column edits per 0-based line, in the input's columns. */
  lineEdits: Map<number, LineEdit[]>
  /** Code units left in place: tagged template text right after a backslash. */
  kept: number
}

/**
 * Rewrites each non-ASCII code unit as `\uXXXX`, which keeps its meaning in strings, untagged
 * template text, regexes, identifiers and comments. Tagged template text gets `${"\uXXXX"}`
 * instead, because an escape there would change `strings.raw` (what String.raw returns).
 */
export function rewriteNonAscii(
  code: string,
  taggedTemplateText: readonly TextRange[] = []
): AsciiRewrite {
  const lineEdits = new Map<number, LineEdit[]>()
  const out: string[] = []
  let line = 0
  let lineStart = 0
  let copiedUpTo = 0
  let rangeIndex = 0
  let kept = 0
  const record = (offset: number, delta: number): void => {
    const edits = lineEdits.get(line) ?? []
    edits.push({ column: offset - lineStart, delta })
    lineEdits.set(line, edits)
  }
  for (let index = 0; index < code.length; index++) {
    const unit = code.charCodeAt(index)
    if (unit === 0x0a) {
      line++
      lineStart = index + 1
      continue
    }
    if (unit <= 0x7f) {
      continue
    }
    while (rangeIndex < taggedTemplateText.length && taggedTemplateText[rangeIndex]!.end <= index) {
      rangeIndex++
    }
    const range = taggedTemplateText[rangeIndex]
    let slashes = 0
    while (index - 1 - slashes >= copiedUpTo && code.charCodeAt(index - 1 - slashes) === 0x5c) {
      slashes++
    }
    if (range && index >= range.start && index < range.end) {
      if (slashes % 2 === 1) {
        // Why kept: `\${` would escape the substitution itself.
        kept++
        continue
      }
      let runEnd = index
      while (runEnd < range.end && code.charCodeAt(runEnd) > 0x7f) {
        runEnd++
      }
      let escaped = ''
      for (let unitIndex = index; unitIndex < runEnd; unitIndex++) {
        escaped += unicodeEscape(code.charCodeAt(unitIndex))
      }
      const substitution = `\${"${escaped}"}`
      out.push(code.slice(copiedUpTo, index), substitution)
      record(index, substitution.length - (runEnd - index))
      copiedUpTo = runEnd
      index = runEnd - 1
      continue
    }
    // Why the backslash goes: `\` before the char is an identity escape, so `\uXXXX` alone matches it.
    const start = slashes % 2 === 1 ? index - 1 : index
    out.push(code.slice(copiedUpTo, start), unicodeEscape(unit))
    record(start, 6 - (index + 1 - start))
    copiedUpTo = index + 1
  }
  out.push(code.slice(copiedUpTo))
  return { code: out.join(''), lineEdits, kept }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = new Map([...BASE64].map((char, index) => [char, index]))

function encodeVlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let encoded = ''
  do {
    const digit = rest & 31
    rest >>>= 5
    encoded += BASE64[rest > 0 ? digit | 32 : digit]
  } while (rest > 0)
  return encoded
}

/** One VLQ value at `offset`; returns it and the offset after it. */
function decodeVlq(text: string, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let index = offset
  for (;;) {
    const digit = BASE64_VALUES.get(text[index] ?? '')
    if (digit === undefined) {
      throw new Error(`Invalid source map mappings near offset ${index}`)
    }
    index++
    result += (digit & 31) * 2 ** shift
    shift += 5
    if ((digit & 32) === 0) {
      return [result % 2 === 1 ? -Math.floor(result / 2) : result / 2, index]
    }
  }
}

/** Moves generated columns past the edits before them. Why only field one: it is the only field
 *  relative to the line; the others are relative to the previous segment and do not change. */
export function shiftGeneratedColumns(
  mappings: string,
  lineEdits: ReadonlyMap<number, readonly LineEdit[]>
): string {
  if (lineEdits.size === 0) {
    return mappings
  }
  return mappings
    .split(';')
    .map((lineMappings, line) => {
      const edits = lineEdits.get(line)
      if (!edits || lineMappings === '') {
        return lineMappings
      }
      let inputColumn = 0
      let previousOutput = 0
      return lineMappings
        .split(',')
        .map((segment) => {
          const [delta, rest] = decodeVlq(segment, 0)
          inputColumn += delta
          let outputColumn = inputColumn
          for (const edit of edits) {
            if (edit.column < inputColumn) {
              outputColumn += edit.delta
            }
          }
          const encoded = encodeVlq(outputColumn - previousOutput) + segment.slice(rest)
          previousOutput = outputColumn
          return encoded
        })
        .join(',')
    })
    .join(';')
}

/** Rewrites `chunk` in `bundle`, and the `.map` asset Rolldown already emitted for it. */
export function rewriteChunkToAscii(
  bundle: Rollup.OutputBundle,
  chunk: Rollup.OutputChunk,
  parse: (code: string) => unknown
): number {
  // Why parse only with a backtick: the AST is needed just to find tagged templates.
  const tagged = chunk.code.includes('`') ? collectTaggedTemplateText(parse(chunk.code)) : []
  const rewrite = rewriteNonAscii(chunk.code, tagged)
  chunk.code = rewrite.code
  const mapAsset = chunk.sourcemapFileName ? bundle[chunk.sourcemapFileName] : undefined
  if (mapAsset?.type === 'asset' && typeof mapAsset.source === 'string') {
    const map: unknown = JSON.parse(mapAsset.source)
    if (isRecord(map) && typeof map.mappings === 'string') {
      map.mappings = shiftGeneratedColumns(map.mappings, rewrite.lineEdits)
      mapAsset.source = JSON.stringify(map)
    }
  }
  return rewrite.kept
}

/** Must run before plugins that edit chunk code in generateBundle, so the map lines still match. */
export function createAsciiBundleSourcePlugin(): Plugin {
  return {
    name: 'orca-ascii-bundle-source',
    generateBundle(_options, bundle) {
      // Why: the memory win is for shipped builds; parsing index.js would add ~1 s to every
      // `electron-vite dev` main rebuild.
      if (this.meta.watchMode) {
        return
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !shouldRewriteToAscii(output.code, output.isEntry)) {
          continue
        }
        const kept = rewriteChunkToAscii(bundle, output, (code) => this.parse(code))
        if (kept > 0) {
          this.warn(
            `${output.fileName}: ${kept} non-ASCII code unit(s) follow a backslash in tagged ` +
              'template text and stay, so V8 keeps this chunk two-byte'
          )
        }
      }
    }
  }
}
