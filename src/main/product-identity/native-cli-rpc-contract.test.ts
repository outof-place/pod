import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RPC_PARAMS_BY_METHOD } from '../../shared/rpc-contract/rpc-params-catalog.generated'

// The native podx client spells runtime methods and param keys as Swift literals. This pins them
// to the params catalog, so a renamed method or key fails in CI without a Swift toolchain. The
// schema projection matches the PodNative bundle (z.toJSONSchema, input side).
const SOURCES = join(__dirname, '../../../native/podx/Sources')

type SwiftFile = { name: string; source: string }
type CallSite = { file: string; line: number; method: string; keys: string[] }

// Index just past the string literal opening at `i`, interpolations included.
function skipString(src: string, i: number): number {
  const triple = src.startsWith('"""', i)
  let j = i + (triple ? 3 : 1)
  while (j < src.length) {
    if (src[j] === '\\') {
      j = src[j + 1] === '(' ? skipGroup(src, j + 1) : j + 2
    } else if (triple ? src.startsWith('"""', j) : src[j] === '"') {
      return j + (triple ? 3 : 1)
    } else {
      j += 1
    }
  }
  return j
}

// Index just past the group opening at `i` (`(`, `[` or `{`), skipping strings and comments.
function skipGroup(src: string, i: number): number {
  let depth = 0
  let j = i
  while (j < src.length) {
    const ch = src[j]
    if (ch === '"') {
      j = skipString(src, j)
      continue
    }
    if (src.startsWith('//', j)) {
      const eol = src.indexOf('\n', j)
      j = eol === -1 ? src.length : eol
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) {
        return j + 1
      }
    }
    j += 1
  }
  return j
}

// Every `{ … }` as [open, close] offsets, inner blocks after the blocks that contain them.
function bracePairs(src: string): [number, number][] {
  const pairs: [number, number][] = []
  const stack: number[] = []
  let j = 0
  while (j < src.length) {
    if (src[j] === '"') {
      j = skipString(src, j)
      continue
    }
    if (src.startsWith('//', j)) {
      const eol = src.indexOf('\n', j)
      j = eol === -1 ? src.length : eol
      continue
    }
    if (src[j] === '{') {
      stack.push(j)
    } else if (src[j] === '}' && stack.length > 0) {
      pairs.push([stack.pop() ?? 0, j])
    }
    j += 1
  }
  return pairs.sort((a, b) => a[0] - b[0])
}

const tupleKeys = (text: string): string[] =>
  [...text.matchAll(/\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,/g)].map((m) => m[1])

// Body text of every top-level or member `func name(...)`, keyed by name.
function functionBodies(files: SwiftFile[]): Map<string, string> {
  const bodies = new Map<string, string>()
  for (const { source } of files) {
    for (const match of source.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const signatureEnd = skipGroup(source, (match.index ?? 0) + match[0].length - 1)
      const open = source.indexOf('{', signatureEnd)
      if (open !== -1) {
        bodies.set(match[1], source.slice(open, skipGroup(source, open)))
      }
    }
  }
  return bodies
}

/**
 * Every `call("ns.method", …)` and `factory("ns.method", …)` site with the param keys it sends:
 * tuple literals in its arguments, plus those of param helpers it calls and, for a factory
 * (a func taking `_ method: String`), the keys the factory's own body adds.
 */
function swiftCallSites(files: SwiftFile[]): CallSite[] {
  const bodies = functionBodies(files)
  const paramHelpers = new Set<string>()
  const factories = new Set<string>()
  for (const { source } of files) {
    for (const m of source.matchAll(
      /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)[^{]*->\s*\[\(String, JSONValue\?\)\]/g
    )) {
      paramHelpers.add(m[1])
    }
    for (const m of source.matchAll(
      /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*_\s+method:\s*String/g
    )) {
      factories.add(m[1])
    }
  }
  const helperKeys = (text: string, seen: Set<string>): string[] =>
    [...paramHelpers]
      .filter((helper) => !seen.has(helper) && new RegExp(`\\b${helper}\\(`).test(text))
      .flatMap((helper) => {
        seen.add(helper)
        return keysOf(bodies.get(helper) ?? '', seen)
      })
  const keysOf = (text: string, seen = new Set<string>()): string[] => [
    ...tupleKeys(text),
    ...helperKeys(text, seen)
  ]
  const sites: CallSite[] = []
  for (const { name: file, source } of files) {
    const blocks = bracePairs(source)
    for (const match of source.matchAll(
      /\b([A-Za-z_][A-Za-z0-9_]*)\(\s*(?:[A-Za-z_][A-Za-z0-9_.]*\s*,\s*)?"([a-z]+(?:\.[A-Za-z]+)+)"/g
    )) {
      const callee = match[1]
      const at = match.index ?? 0
      // `send(metadata, "method", …)` names the method second; calls and factories name it first.
      const methodSecond = !/\(\s*"/.test(match[0])
      if (methodSecond ? callee !== 'send' : callee !== 'call' && !factories.has(callee)) {
        continue
      }
      const open = at + callee.length
      const keys = keysOf(source.slice(open, skipGroup(source, open)))
      if (factories.has(callee)) {
        keys.push(...keysOf(bodies.get(callee) ?? ''))
      }
      // Params built by helpers into locals earlier in the same block (`let target = …`).
      const block = blocks.findLast(([start, end]) => start < at && at < end)
      if (block) {
        keys.push(...helperKeys(source.slice(block[0], at), new Set()))
      }
      sites.push({
        file,
        line: source.slice(0, match.index).split('\n').length,
        method: match[2],
        keys: [...new Set(keys)]
      })
    }
  }
  return sites
}

type JsonSchema = {
  properties?: Record<string, unknown>
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  additionalProperties?: unknown
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? swiftFiles(join(dir, entry.name))
      : entry.name.endsWith('.swift')
        ? [join(dir, entry.name)]
        : []
  )
}

function acceptedKeys(schema: JsonSchema): { keys: Set<string>; open: boolean } {
  const keys = new Set(Object.keys(schema.properties ?? {}))
  let open = schema.additionalProperties !== undefined && schema.additionalProperties !== false
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? [])
  ]) {
    const nested = acceptedKeys(branch)
    nested.keys.forEach((key) => keys.add(key))
    open ||= nested.open
  }
  return { keys, open }
}

const catalog: Record<string, z.ZodType | null> = RPC_PARAMS_BY_METHOD
const files: SwiftFile[] = swiftFiles(SOURCES).map((file) => ({
  name: file.slice(SOURCES.length + 1),
  source: readFileSync(file, 'utf8')
}))
const sites = swiftCallSites(files)

describe('native podx runtime calls', () => {
  it('finds a call site for every method literal in the sources', () => {
    // Why: a scanner that silently stops matching would pass every check below.
    const literals = new Set(
      files.flatMap(({ source }) =>
        [...source.matchAll(/"([a-z]+(?:\.[A-Za-z]+)+)"/g)].map((m) => m[1])
      )
    )
    const found = new Set(sites.map((site) => site.method))
    expect([...literals].filter((method) => !found.has(method))).toEqual([])
    expect(found.size).toBeGreaterThan(50)
  })

  it('only sends methods the runtime catalog defines', () => {
    const unknown = sites.filter((site) => !(site.method in catalog))
    expect(unknown.map((site) => `${site.file}:${site.line} ${site.method}`)).toEqual([])
  })

  it('only sends param keys the method schema accepts', () => {
    const rejected: string[] = []
    for (const site of sites) {
      const schema = catalog[site.method]
      if (schema === undefined) {
        continue
      }
      if (schema === null) {
        rejected.push(
          ...site.keys.map(
            (key) => `${site.file}:${site.line} ${site.method} takes no params, got ${key}`
          )
        )
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: toJSONSchema returns a JSON Schema object; only the keyword fields typed above are read.
      const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
      const { keys, open } = acceptedKeys(json)
      if (!open) {
        rejected.push(
          ...site.keys
            .filter((key) => !keys.has(key))
            .map((key) => `${site.file}:${site.line} ${site.method} does not accept ${key}`)
        )
      }
    }
    expect(rejected).toEqual([])
  })
})
