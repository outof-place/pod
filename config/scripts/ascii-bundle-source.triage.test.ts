// Triage repro for stablyai/orca#27314 (closed): each case asserts the behavior the rewrite must
// preserve, so it fails on the transformer from perf/ascii-main-bundle 00d26f9cf8.
import { parseAst } from 'vite'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { collectTaggedTemplateText, rewriteNonAscii } from '../build-plugins/ascii-bundle-source'

function rewrite(code: string): string {
  return rewriteNonAscii(code, collectTaggedTemplateText(parseAst(code))).code
}

describe('#27314 ascii rewrite keeps program meaning', () => {
  it('keeps tagged-template arguments', () => {
    const code = 'const tag = (s, ...v) => [s.length, v.length]; result = tag`café`'
    const before = runInNewContext(`${code}; result`)
    const after = runInNewContext(`${rewrite(code)}; result`)
    expect(after).toEqual(before)
  })

  it('keeps non-ASCII whitespace valid', () => {
    const code = 'var x = 1; result = x'
    expect(runInNewContext(`${code}; result`)).toBe(1)
    expect(() => runInNewContext(`${rewrite(code)}; result`)).not.toThrow()
  })

  it('keeps code after a Unicode line terminator that ends a comment', () => {
    const code = 'result = 1; // note result = 2\n'
    expect(runInNewContext(`${code}; result`)).toBe(2)
    expect(runInNewContext(`${rewrite(code)}; result`)).toBe(2)
  })
})
