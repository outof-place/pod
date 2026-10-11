// Applies #27314's rewrite to every built main chunk and reports chunks whose AST changes.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import { collectTaggedTemplateText, rewriteNonAscii } from '../build-plugins/ascii-bundle-source'

const root = process.argv[2]!
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : []
  })
}
function parse(code: string): acorn.Node {
  const opts = { ecmaVersion: 'latest' as const, allowReturnOutsideFunction: true, allowHashBang: true }
  try { return acorn.parse(code, { ...opts, sourceType: 'script' }) } catch { return acorn.parse(code, { ...opts, sourceType: 'module' }) }
}
function strip(node: unknown): unknown {
  return JSON.stringify(node, (key, value) => (['start', 'end', 'raw', 'loc', 'range', 'pattern', 'bigint'].includes(key) ? undefined : typeof value === 'bigint' ? String(value) : value))
}
let scanned = 0
for (const file of walk(root)) {
  const code = readFileSync(file, 'utf8')
  if (!/[^\x00-\x7f]/.test(code)) continue
  scanned++
  const before = parse(code)
  const out = rewriteNonAscii(code, collectTaggedTemplateText(before)).code
  let after: acorn.Node
  try { after = parse(out) } catch (error) { console.log('SYNTAX', file, String(error)); continue }
  const a = strip(before) as string
  const b = strip(after) as string
  if (a !== b) {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    console.log('AST-DIFF', file, '\n   before:', a.slice(Math.max(0, i - 160), i + 120), '\n   after: ', b.slice(Math.max(0, i - 160), i + 120))
  }
  const ls = (code.match(/[\u2028\u2029]/g) ?? []).length
  if (ls) console.log('LS/PS chars', file, ls)
}
console.log('scanned non-ASCII chunks:', scanned)
