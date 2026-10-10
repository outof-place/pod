import { describe, expect, it } from 'vitest'
import {
  shouldRewriteToAscii,
  rewriteNonAscii,
  shiftGeneratedColumns
} from '../build-plugins/ascii-bundle-source'

const EM_DASH = String.fromCharCode(0x2014)
const QUOTE = String.fromCharCode(0x2019)
const GRIN = String.fromCodePoint(0x1f600)
const E_ACUTE = String.fromCharCode(0xe9)

function hasNonAsciiCodeUnits(code: string): boolean {
  return /[\u0080-\uffff]/.test(code)
}

function evaluate(source: string): unknown {
  return new Function(`return (${source})`)()
}

/** The literal text between the first backticks after `tag`. */
function templateText(source: string, tag: string): { start: number; end: number } {
  const start = source.indexOf(`${tag}\``) + tag.length + 1
  return { start, end: source.indexOf('`', start) }
}

describe('ASCII bundle source rewrite', () => {
  it.each([
    ['a string', `"a${EM_DASH}b"`],
    ['an identity escape', `"\\${EM_DASH}"`],
    ['a regex', `/${QUOTE}s?$/.test("x${QUOTE}s")`],
    ['untagged template text', `\`x${EM_DASH}\${1 + 1}y\``],
    ['a surrogate pair', `"${GRIN}".codePointAt(0)`],
    ['a comment', `/* ${EM_DASH} */ 7`],
    ['a Latin-1 letter', `"caf${E_ACUTE}"`]
  ])('keeps the value of %s and leaves no non-ASCII code unit', (_label, source) => {
    const { code, kept } = rewriteNonAscii(source)
    expect(hasNonAsciiCodeUnits(code)).toBe(false)
    expect(kept).toBe(0)
    expect(evaluate(code)).toEqual(evaluate(source))
  })

  it("keeps String.raw's result through a substitution", () => {
    const source = `String.raw\`a${EM_DASH}${QUOTE}b\${1}c${EM_DASH}\``
    const ranges = [templateText(source, 'String.raw')]
    // Why two ranges: the substitution splits the text into two literal parts.
    const split = source.indexOf('${1}')
    const { code } = rewriteNonAscii(source, [
      { start: ranges[0]!.start, end: split },
      { start: split + 4, end: source.lastIndexOf('`') }
    ])
    expect(hasNonAsciiCodeUnits(code)).toBe(false)
    expect(evaluate(code)).toBe(evaluate(source))
  })

  it('leaves a code unit that follows a backslash in tagged template text', () => {
    const source = `String.raw\`\\${EM_DASH}\``
    const { code, kept } = rewriteNonAscii(source, [templateText(source, 'String.raw')])
    expect(kept).toBe(1)
    expect(code).toBe(source)
  })

  it('rewrites a chunk only when its source gets smaller in memory', () => {
    const latin1Only = `"caf${E_ACUTE}"${'x'.repeat(10)}`
    // Why: a main script is kept two-byte for any non-ASCII; a required chunk only above U+00FF.
    expect(shouldRewriteToAscii(latin1Only, true)).toBe(true)
    expect(shouldRewriteToAscii(latin1Only, false)).toBe(false)
    expect(shouldRewriteToAscii(`"${EM_DASH}"${'x'.repeat(10)}`, false)).toBe(true)
    expect(shouldRewriteToAscii('plain ascii', true)).toBe(false)
    // Why: 5 more characters per escape outgrow two bytes per character once a fifth is non-ASCII.
    expect(shouldRewriteToAscii(`"${EM_DASH.repeat(10)}"${'x'.repeat(30)}`, true)).toBe(false)
  })

  it('records each edit on its line', () => {
    const { lineEdits } = rewriteNonAscii(`"${EM_DASH}"\n"\\${EM_DASH}${EM_DASH}"`)
    expect(lineEdits.get(0)).toEqual([{ column: 1, delta: 5 }])
    // Why 4 for the first: the dropped backslash belonged to the identity escape.
    expect(lineEdits.get(1)).toEqual([
      { column: 1, delta: 4 },
      { column: 3, delta: 5 }
    ])
  })
})

describe('source map column shift', () => {
  it('moves only the generated columns after an edit on the same line', () => {
    // Line 0: columns 0, 5, 10 (deltas 0, 5, 5), each with source fields; line 1 untouched.
    const mappings = 'AAAA,KAAC,KAAE;AACA'
    const shifted = shiftGeneratedColumns(mappings, new Map([[0, [{ column: 3, delta: 5 }]]]))
    // Segment one stays at 0; two moves 5 -> 10 (delta 10 = "U"); three 10 -> 15 (delta 5 = "K").
    expect(shifted).toBe('AAAA,UAAC,KAAE;AACA')
  })

  it('round-trips values that need more than one base64 digit', () => {
    const mappings = 'gCAAA,8BAAC'
    expect(shiftGeneratedColumns(mappings, new Map([[0, [{ column: 1000, delta: 5 }]]]))).toBe(
      mappings
    )
  })
})
