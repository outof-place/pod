// Code search the way coding agents run it, on one large repo: 24 fixed queries (literals and
// regexes), each as its own process, first one at a time and then all 24 at once (a fleet of
// agents searching in parallel). The OS file cache is warm (a warm-up round runs first).
//
//   node bench/suites/search.mjs [--repo DIR] [--rounds 5] [--engines rg,og] [--og BIN]
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  collectSamples,
  commandVersion,
  log,
  sleep,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    repo: { type: 'string', default: path.join(os.homedir(), 'Documents/portivo-app/Untitled') },
    rounds: { type: 'string', default: '5' },
    engines: { type: 'string', default: 'rg' },
    rg: { type: 'string', default: 'rg' },
    // og is pod-search's ripgrep fork (third_party/ripgrep, binary `rg`); ogd its index daemon.
    og: { type: 'string' },
    'og-sha': { type: 'string' },
    ogd: { type: 'string' },
    ogctl: { type: 'string' }
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
  // The same arguments: og is a ripgrep fork with rg's argv and output.
  og: (pattern, regex) => [
    options.og,
    ['--no-config', '-n', ...(regex ? [] : ['-F']), '-e', pattern, '.']
  ]
}

const run = promisify(execFile)

// og answers from a running ogd; this run gets its own daemon, socket and state, then stops it.
let ogEnv = {}
let ogStatus = null
async function startOgd() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-ogd-'))
  ogEnv = {
    POD_SEARCH_SOCKET: path.join(dir, 'ogd.sock'),
    POD_SEARCH_STATE_DIR: path.join(dir, 'state')
  }
  const daemon = spawn(
    options.ogd,
    ['--socket', ogEnv.POD_SEARCH_SOCKET, '--state-dir', ogEnv.POD_SEARCH_STATE_DIR],
    {
      stdio: 'ignore'
    }
  )
  for (let i = 0; i < 100 && !existsSync(ogEnv.POD_SEARCH_SOCKET); i += 1) {
    await sleep(100)
  }
  await run(options.ogctl, ['register', '--wait', repo], {
    env: { ...process.env, ...ogEnv },
    timeout: 600_000
  })
  return { daemon, dir }
}
async function stopOgd(ogd) {
  ogStatus = JSON.parse(
    (await run(options.ogctl, ['status'], { env: { ...process.env, ...ogEnv } })).stdout
  )
  await run(options.ogctl, ['shutdown'], { env: { ...process.env, ...ogEnv } }).catch(() =>
    ogd.daemon.kill('SIGTERM')
  )
  rmSync(ogd.dir, { recursive: true, force: true })
}

function search(engine, [pattern, regex]) {
  const [program, args] = ENGINES[engine](pattern, regex)
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    execFile(
      program,
      args,
      {
        cwd: repo,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer',
        env: engine === 'og' ? { ...process.env, ...ogEnv } : process.env
      },
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
  versions.og = {
    version: commandVersion(options.og),
    podSearchSha: options['og-sha'] ?? null,
    binary: options.og
  }
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
  const ogd = engine === 'og' ? await startOgd() : null
  // Warm the file cache and the index.
  for (const query of QUERIES) {
    await search(engine, query)
  }
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
  if (ogd) {
    await stopOgd(ogd)
  }
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
  ogdStatus: ogStatus,
  versions,
  repo: repoFacts,
  config: { rounds, queries: QUERIES, engines },
  matchCounts,
  disagreements,
  metrics,
  comparisons,
  samples
})
