// Collects every suite's headline metrics in results/<date>/ into summary.json: per metric the
// median, p95, n and the versions measured, plus Pod-vs-Orca comparisons (who is ahead, by how much).
//
//   node bench/summarize.mjs [results/<date>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './lib/bench-session.mjs'

const dir = path.resolve(
  process.argv[2] ?? path.join(BENCH_ROOT, 'results', new Date().toISOString().slice(0, 10))
)
const suites = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== 'summary.json')
  .map((file) => ({ file, ...JSON.parse(readFileSync(path.join(dir, file), 'utf8')) }))

const metrics = []
const comparisons = []
for (const suite of suites) {
  for (const row of suite.metrics ?? []) {
    metrics.push({
      id: row.id,
      suite: suite.suite,
      subject: row.subject,
      metric: row.metric,
      unit: row.unit,
      better: row.better,
      n: row.stats?.n ?? 0,
      median: row.stats?.median ?? null,
      p95: row.stats?.p95 ?? null,
      min: row.stats?.min ?? null,
      max: row.stats?.max ?? null,
      extra: row.extra ?? null,
      conditions: row.conditions,
      source: suite.file
    })
  }
  // Orca vs Pod pairs share an id prefix: <suite>.<...>.orca vs <suite>.<...>.pod-*.
  const byId = new Map((suite.metrics ?? []).map((row) => [row.id, row]))
  const explicit = suite.comparisons ?? []
  const automatic = [...byId.keys()]
    .filter((id) => id.endsWith('.orca'))
    .flatMap((id) =>
      ['pod-native', 'pod-xterm', 'pod']
        .map((pod) => `${id.slice(0, -'orca'.length)}${pod}`)
        .filter((candidate) => byId.has(candidate))
        .map((candidate) => ({ baseline: id, candidate }))
    )
  for (const pair of [...explicit, ...automatic]) {
    const baseline = byId.get(pair.baseline)
    const candidate = byId.get(pair.candidate)
    const b = baseline?.stats?.median
    const c = candidate?.stats?.median
    if (!Number.isFinite(b) || !Number.isFinite(c) || b === 0 || c === 0) {
      continue
    }
    const lowerIsBetter = baseline.better !== 'higher'
    const factor = lowerIsBetter ? b / c : c / b
    comparisons.push({
      metric: candidate.metric,
      baseline: { id: pair.baseline, subject: baseline.subject, median: b },
      candidate: { id: pair.candidate, subject: candidate.subject, median: c },
      unit: candidate.unit,
      // >1: the candidate is ahead by this factor; <1: behind.
      factor: Number(factor.toFixed(3)),
      candidateAhead: factor > 1,
      label: pair.label ?? null
    })
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  resultsDir: path.relative(BENCH_ROOT, dir),
  hardware: 'MacBook Pro, Apple M4 Max (16 cores: 12 performance + 4 efficiency), 48 GB, macOS 27',
  machine: suites[0]?.machine ?? null,
  maxLoad: suites[0]?.maxLoad ?? null,
  aggregation: suites[0]?.aggregation ?? null,
  suites: Object.fromEntries(
    suites.map((suite) => [
      suite.suite,
      {
        file: suite.file,
        writtenAt: suite.writtenAt,
        versions: suite.versions,
        config: suite.config
      }
    ])
  ),
  metrics,
  comparisons
}
writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(
  `summary: ${metrics.length} metrics, ${comparisons.length} comparisons -> ${path.join(dir, 'summary.json')}`
)
