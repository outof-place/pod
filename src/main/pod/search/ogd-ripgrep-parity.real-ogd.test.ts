import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SearchOptions } from '../../../shared/code-search-types'
import { BUNDLED_RIPGREP_PACKAGE_BIN_DIR } from '../../../shared/bundled-ripgrep'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import {
  buildRgArgsForQuickOpen,
  shouldIncludeQuickOpenPath
} from '../../../shared/quick-open-filter'
import { decodeRipgrepLine } from '../../../shared/ripgrep-line-decoding'
import { buildRgArgs } from '../../../shared/text-search'
import { OgdClient } from './ogd-client'
import { isOgdMessage } from './ogd-connection'
import { decodeOgdPathList, quickOpenRipgrepGlobs } from './pod-search-listing'
import {
  OGD_FEATURE_FILES_EXCLUDE,
  OGD_FEATURE_FILES_IGNORED,
  OGD_FEATURE_SEARCH_FULL_LINES,
  OGD_FEATURE_SEARCH_MAX_FILESIZE,
  OGD_FEATURE_SEARCH_NEGATED_GLOBS
} from './pod-search-provider'
import { buildOgdSearchRequest } from './pod-search-text-results'

// Real-daemon parity: ogd must return exactly what Orca's bundled ripgrep returns, line by line
// and range by range. Opt-in: ORCA_E2E_OGD_BIN=/path/to/ogd ORCA_OGD_PARITY_REPO=/path/to/repo.
// ORCA_OGD_PARITY_RUNS=N also logs median engine latency per query (the pod-bench suite).
// ORCA_OGD_PARITY_RG picks the reference rg (default: Orca's bundled one). og forks rg 15.2.0, so
// a diff that shows against only one rg version is a ripgrep version delta, not an ogd bug.
// ORCA_OGD_PARITY_REPORT=/path.json writes the rg version, mismatches and timings there.
const ogdBin = process.env.ORCA_E2E_OGD_BIN
const parityRepo = process.env.ORCA_OGD_PARITY_REPO
const referenceRipgrep = process.env.ORCA_OGD_PARITY_RG
const runs = Math.max(1, Number(process.env.ORCA_OGD_PARITY_RUNS ?? '1') || 1)
const UNLIMITED = 10_000_000
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024

/** The Portivo query set, shared with the in-app E2E (tests/e2e/pod-native-search.spec.ts). */
const TEXT_QUERIES: Omit<SearchOptions, 'rootPath'>[] = [
  { query: 'useEffect' },
  { query: 'TODO' },
  { query: 'export default function' },
  { query: 'useEffect', caseSensitive: true },
  { query: 'use', wholeWord: true },
  { query: String.raw`use[A-Z]\w+\(`, useRegex: true },
  { query: 'import', includePattern: '*.tsx' },
  { query: 'import', excludePattern: '**/*.test.ts, node_modules/**' }
]

type LineHit = { text: string; ranges: string }

let daemon: ReturnType<typeof spawnProcess> | null = null
let client: OgdClient | null = null
let stateDir = ''
let root = ''
const timings: Record<string, { ogd: number; rg: number }> = {}
const mismatches: Record<string, unknown> = {}

function requireClient(): OgdClient {
  if (!client) {
    throw new Error('ogd did not start')
  }
  return client
}

let ripgrepVersion = ''

function ripgrepPath(): string {
  if (referenceRipgrep) {
    return referenceRipgrep
  }
  return join(
    process.cwd(),
    BUNDLED_RIPGREP_PACKAGE_BIN_DIR,
    `${process.platform}-${process.arch}`,
    'rg'
  )
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  let value: T | undefined
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    value = await work()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  if (value === undefined) {
    throw new Error('no run')
  }
  return { value, ms: Math.round(samples[Math.floor(samples.length / 2)]) }
}

async function runRipgrep(args: string[]): Promise<string> {
  const result = await runProcess({
    program: ripgrepPath(),
    args,
    cwd: root,
    timeoutMs: 300_000,
    maxOutputBytes: MAX_OUTPUT_BYTES
  })
  // Exit 1 means no match.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`rg exited ${result.code}: ${result.stderr}`)
  }
  return result.stdout
}

function ripgrepHits(stdout: string): Map<string, LineHit> {
  const hits = new Map<string, LineHit>()
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue
    }
    const message: unknown = JSON.parse(line)
    if (!isOgdMessage(message) || message.type !== 'match' || !isOgdMessage(message.data)) {
      continue
    }
    const data = message.data
    const path =
      isOgdMessage(data.path) && typeof data.path.text === 'string' ? data.path.text : '?'
    const lines = isOgdMessage(data.lines) ? data.lines : {}
    const submatches = Array.isArray(data.submatches) ? data.submatches : []
    hits.set(`${path.replace(/^\.\//, '')}:${String(data.line_number)}`, {
      text: decodeRipgrepLine({
        text: typeof lines.text === 'string' ? lines.text : undefined,
        bytes: typeof lines.bytes === 'string' ? lines.bytes : undefined
      }).text,
      ranges: JSON.stringify(
        submatches.map((sub) => (isOgdMessage(sub) ? [sub.start, sub.end] : null))
      )
    })
  }
  return hits
}

function ogdHits(matches: unknown): Map<string, LineHit> {
  const hits = new Map<string, LineHit>()
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!isOgdMessage(match)) {
      continue
    }
    hits.set(`${String(match.path)}:${String(match.line)}`, {
      text: decodeRipgrepLine({
        text: typeof match.text === 'string' ? match.text : undefined,
        bytes: typeof match.bytes === 'string' ? match.bytes : undefined
      }).text,
      ranges: JSON.stringify(match.ranges)
    })
  }
  return hits
}

function differences(ogd: Map<string, LineHit>, rg: Map<string, LineHit>): string[] {
  const out: string[] = []
  for (const key of new Set([...ogd.keys(), ...rg.keys()])) {
    const [a, b] = [ogd.get(key), rg.get(key)]
    if (!a || !b) {
      out.push(`${key}: only in ${a ? 'ogd' : 'rg'}`)
    } else if (a.ranges !== b.ranges) {
      out.push(`${key}: ranges ogd ${a.ranges} rg ${b.ranges}`)
    } else if (a.text !== b.text) {
      out.push(`${key}: line text differs (${a.text.length} vs ${b.text.length} code units)`)
    }
  }
  return out
}

describe.skipIf(!ogdBin || !parityRepo || process.platform === 'win32')(
  'ogd vs ripgrep parity',
  () => {
    beforeAll(async () => {
      root = realpathSync(String(parityRepo))
      const version = await runProcess({ program: ripgrepPath(), args: ['--version'] })
      ripgrepVersion = version.stdout.split('\n')[0] ?? ''
      stateDir = mkdtempSync(join(tmpdir(), 'ogd-parity-'))
      const socketPath = join(stateDir, 'ogd.sock')
      daemon = spawnProcess({
        program: String(ogdBin),
        args: ['--socket', socketPath, '--state-dir', join(stateDir, 'state'), '--idle-secs', '900']
      })
      daemon.stdout.resume()
      daemon.stderr.resume()
      client = new OgdClient({ socketPath, client: 'orca/parity', timeoutMs: 600_000 })
      for (let attempt = 0; ; attempt++) {
        try {
          await client.request('register', { root, wait: true })
          break
        } catch (error) {
          if (attempt > 100) {
            throw error
          }
          // The socket appears once the daemon is listening; the client backs off in between.
          await new Promise((resolve) => setTimeout(resolve, 100))
          client.close()
          client = new OgdClient({ socketPath, client: 'orca/parity', timeoutMs: 600_000 })
        }
      }
    }, 600_000)

    afterAll(() => {
      client?.close()
      daemon?.kill()
      rmSync(stateDir, { recursive: true, force: true })
      const summary = { repo: root, rg: ripgrepVersion, runs, mismatches, timings }
      if (process.env.ORCA_OGD_PARITY_REPORT) {
        writeFileSync(process.env.ORCA_OGD_PARITY_REPORT, `${JSON.stringify(summary, null, 2)}\n`)
      }
      console.log(`[ogd-parity] ${JSON.stringify(summary, null, 2)}`)
    })

    it('returns the same lines and byte ranges as the bundled ripgrep', async () => {
      const ogd = requireClient()
      // Without these the client never sends ogd a text search, so there is nothing to compare.
      expect(ogd.hasFeature(OGD_FEATURE_SEARCH_FULL_LINES)).toBe(true)
      expect(ogd.hasFeature(OGD_FEATURE_SEARCH_MAX_FILESIZE)).toBe(true)
      const report: Record<string, string[]> = {}
      for (const query of TEXT_QUERIES) {
        const options: SearchOptions = { ...query, rootPath: root }
        const { fields, hasGlobs } = buildOgdSearchRequest(options, root)
        const label = JSON.stringify(query)
        if (hasGlobs && !ogd.hasFeature(OGD_FEATURE_SEARCH_NEGATED_GLOBS)) {
          report[label] = ['skipped: daemon lacks search.negated_globs, so Orca keeps it on rg']
          continue
        }
        const indexed = await timed(async () =>
          ogd.request('search', { ...fields, limit: UNLIMITED, max_matches: UNLIMITED })
        )
        const ripgrep = await timed(() => runRipgrep(buildRgArgs(options.query, '.', options)))
        timings[`search ${label}`] = { ogd: indexed.ms, rg: ripgrep.ms }
        expect(indexed.value.message.truncated).not.toBe(true)
        const diff = differences(ogdHits(indexed.value.message.matches), ripgrepHits(ripgrep.value))
        if (diff.length > 0) {
          report[label] = diff.slice(0, 10)
        }
      }
      const textMismatches = Object.fromEntries(
        Object.entries(report).filter(([, v]) => !v[0]?.startsWith('skipped'))
      )
      Object.assign(mismatches, report)
      expect({ rg: ripgrepVersion, textMismatches }).toEqual({
        rg: ripgrepVersion,
        textMismatches: {}
      })
    }, 1_800_000)

    it('lists the same quick-open files as the bundled ripgrep', async () => {
      const ogd = requireClient()
      const { primary, ignoredPass } = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      const ripgrepFiles = async (args: string[]) =>
        (await runRipgrep(args))
          .split('\0')
          .map((path) => path.replace(/^\.\//, ''))
          .filter((path) => path.length > 0 && shouldIncludeQuickOpenPath(path))
      for (const ignored of [false, true]) {
        if (ignored && !ogd.hasFeature(OGD_FEATURE_FILES_IGNORED)) {
          continue
        }
        const indexed = await timed(async () =>
          ogd.request('files', {
            root,
            hidden: true,
            barrier: true,
            ...(ignored ? { ignored: true } : {}),
            ...(ogd.hasFeature(OGD_FEATURE_FILES_EXCLUDE)
              ? { globs: quickOpenRipgrepGlobs([]) }
              : {})
          })
        )
        const ripgrep = await timed(async () => [
          ...(await ripgrepFiles(primary)),
          ...(ignored ? await ripgrepFiles(ignoredPass) : [])
        ])
        timings[`files ignored=${ignored}`] = { ogd: indexed.ms, rg: ripgrep.ms }
        const fromOgd = new Set(
          decodeOgdPathList(indexed.value.binary).filter(shouldIncludeQuickOpenPath)
        )
        const fromRg = new Set(ripgrep.value)
        const onlyOgd = [...fromOgd].filter((path) => !fromRg.has(path))
        const onlyRg = [...fromRg].filter((path) => !fromOgd.has(path))
        if (onlyOgd.length > 0 || onlyRg.length > 0) {
          mismatches[`files ignored=${ignored}`] = {
            onlyOgd: onlyOgd.slice(0, 10),
            onlyRg: onlyRg.slice(0, 10)
          }
        }
        expect({
          rg: ripgrepVersion,
          ignored,
          onlyOgd: onlyOgd.slice(0, 10),
          onlyRg: onlyRg.slice(0, 10)
        }).toEqual({
          rg: ripgrepVersion,
          ignored,
          onlyOgd: [],
          onlyRg: []
        })
      }
    }, 1_800_000)
  }
)
