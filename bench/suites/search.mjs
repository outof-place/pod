// Code search the way coding agents run it, on one large repo: 24 fixed queries (literals and
// regexes), each as its own process, first one at a time and then all 24 at once (a fleet of
// agents searching in parallel). The OS file cache is warm (a warm-up round runs first).
//
//   node bench/suites/search.mjs [--repo DIR] [--rounds 5] [--engines rg,og] [--og BIN]
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { collectSamples, commandVersion, log, writeSuiteResult } from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    repo: { type: 'string', default: path.join(os.homedir(), 'Documents/portivo-app/Untitled') },
    rounds: { type: 'string', default: '5' },
    engines: { type: 'string', default: 'rg' },
    rg: { type: 'string', default: 'rg' },
    og: {
      type: 'string',
      default: path.join(os.homedir(), 'Documents/pod-search/target/release/og')
    }
  }
})
const repo = options.repo
const rounds = Number(options.rounds)

// [pattern, regex?]: identifiers, call sites, strings and a few regexes an agent would grep for.
const QUERIES = [
  ['useState', false],
  ['useEffect', false],
  ['createContext', false],
  ['TODO', false],
  ['console.error', false],
  ['process.env', false],
  ['throw new Error', false],
  ['Promise.all', false],
  ['JSON.parse', false],
  ['setTimeout', false],
  ['export default function', false],
  ['interface Props', false],
  ['className=', false],
  ['localhost', false],
  ['@deprecated', false],
  ['async function', false],
  ['func \\w+Handler\\(', true],
  ['import .* from [\'"]react[\'"]', true],
  ['\\bErr[A-Z]\\w+\\b', true],
  ['https?://[a-z0-9.-]+', true],
  ['useQuery\\(\\{', true],
  ['SELECT .* FROM', true],
  ['t\\.Run\\("', true],
  ["\\.(get|post|put|delete)\\('/", true]
]

const ENGINES = {
  // --no-config: the user's RIPGREP_CONFIG_PATH must not change what is measured.
  rg: (pattern, regex) => [
    options.rg,
    ['--no-config', '-n', ...(regex ? [] : ['-F']), '-e', pattern, '.']
  ],
  og: (pattern, regex) => [options.og, ['-n', ...(regex ? [] : ['-F']), '-e', pattern, '.']]
}

function search(engine, [pattern, regex]) {
  const [program, args] = ENGINES[engine](pattern, regex)
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    execFile(
      program,
      args,
      { cwd: repo, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        // Exit 1 = no match, which is a valid answer.
        if (error && error.code !== 1) {
          return reject(error)
        }
        const lines =
          stdout.length === 0 ? 0 : stdout.toString('utf8').split('\n').filter(Boolean).length
        resolve({ ms, lines })
      }
    )
  })
}

const engines = options.engines.split(',')
const versions = { rg: commandVersion(options.rg) }
if (engines.includes('og')) {
  versions.og = commandVersion(options.og)
}
const { stdout: tracked } = await new Promise((resolve, reject) =>
  execFile('git', ['ls-files', '-z'], { cwd: repo, maxBuffer: 256 * 1024 * 1024 }, (error, out) =>
    error ? reject(error) : resolve({ stdout: out })
  )
)
const repoFacts = { path: repo, trackedFiles: tracked.split('\0').filter(Boolean).length }
log('repo', JSON.stringify(repoFacts))

const matchCounts = {}
const samples = {}
for (const engine of engines) {
  for (const query of QUERIES) {
    await search(engine, query)
  } // warm the file cache and any index
  samples[engine] = await collectSamples({
    label: `search ${engine}`,
    count: rounds,
    measure: async (index) => {
      const sequential = []
      for (const query of QUERIES) {
        const result = await search(engine, query)
        sequential.push(result.ms)
        if (index === 0) {
          matchCounts[`${engine}:${query[0]}`] = result.lines
        }
      }
      const t0 = process.hrtime.bigint()
      const parallel = await Promise.all(QUERIES.map((query) => search(engine, query)))
      const makespanMs = Number(process.hrtime.bigint() - t0) / 1e6
      return {
        sequentialTotalMs: sequential.reduce((a, b) => a + b, 0),
        parallelMakespanMs: makespanMs,
        sequentialMs: sequential,
        parallelMs: parallel.map((result) => result.ms)
      }
    }
  })
}

// Same answers? Compare per-query match-line counts between engines.
const disagreements =
  engines.length > 1
    ? QUERIES.filter(
        ([pattern]) =>
          new Set(engines.map((engine) => matchCounts[`${engine}:${pattern}`])).size > 1
      ).map(([pattern]) => ({
        pattern,
        ...Object.fromEntries(
          engines.map((engine) => [engine, matchCounts[`${engine}:${pattern}`]])
        )
      }))
    : []

const metrics = []
const conditions = `${repoFacts.trackedFiles} tracked files, ${QUERIES.length} queries, warm OS file cache, ${rounds} rounds`
for (const engine of engines) {
  const accepted = samples[engine].filter((sample) => !sample.warmup)
  metrics.push(
    {
      id: `search.single.${engine}`,
      subject: `${engine} ${versions[engine] ?? ''}`.trim(),
      metric: 'one search, one at a time',
      unit: 'ms',
      better: 'lower',
      stats: summarize(
        accepted.flatMap((sample) => sample.sequentialMs),
        'ms'
      ),
      conditions
    },
    {
      id: `search.parallel24.${engine}`,
      subject: `${engine} ${versions[engine] ?? ''}`.trim(),
      metric: '24 searches at once: time until all finish',
      unit: 'ms',
      better: 'lower',
      stats: summarize(
        accepted.map((sample) => sample.parallelMakespanMs),
        'ms'
      ),
      extra: {
        perSearch: summarize(
          accepted.flatMap((sample) => sample.parallelMs),
          'ms'
        )
      },
      conditions
    }
  )
}
const comparisons = engines.includes('og')
  ? [
      {
        baseline: 'search.single.rg',
        candidate: 'search.single.og',
        label: 'one search: rg vs og'
      },
      {
        baseline: 'search.parallel24.rg',
        candidate: 'search.parallel24.og',
        label: '24 parallel searches: rg vs og'
      }
    ]
  : []
writeSuiteResult('search', {
  versions,
  repo: repoFacts,
  config: { rounds, queries: QUERIES, engines },
  matchCounts,
  disagreements,
  metrics,
  comparisons,
  samples
})
