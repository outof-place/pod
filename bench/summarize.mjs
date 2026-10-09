// Collects every suite's headline metrics in results/<date>/ into summary.json: per metric the
// median, p95, n, the versions measured, where the number comes from (provenance) and its caveats,
// plus the comparisons (who is ahead, by how much). Schema: bench/README.md#summaryjson.
//
//   node bench/summarize.mjs [results/<date>]
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from './lib/bench-session.mjs'

const SCHEMA_VERSION = 2
const METHODOLOGY = {
  path: 'bench/README.md',
  url: 'https://github.com/outof-place/pod/blob/pod/bench/bench/README.md'
}
const GLOBAL_CAVEATS = [
  'One Mac, one subject at a time in rotating order; every fresh sample started at a 1-minute load average of 8 or less.',
  'Orca is the latest official release; Pod is the build named in versions. Pod sits on a newer Orca main commit than the Orca release, so part of any difference can come from upstream changes; the Pod (xterm.js) rows separate the native terminal from the rest of the build.',
  'Historical rows (provenance.kind "historical") were measured earlier, under the conditions in their note, and are not re-measured in this run.'
]

const dir = path.resolve(
  process.argv[2] ?? path.join(BENCH_ROOT, 'results', new Date().toISOString().slice(0, 10))
)
const suites = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== 'summary.json')
  .map((file) => ({ file, ...JSON.parse(readFileSync(path.join(dir, file), 'utf8')) }))

// Which topic branches Pod's product stack carries (origin/main:pod-stack.json), so a row that
// comes from a branch can say whether that change is in Pod yet.
function podStack() {
  const git = (args) =>
    execFileSync('git', ['-C', path.dirname(BENCH_ROOT), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  try {
    const manifest = JSON.parse(git(['show', 'origin/main:pod-stack.json']))
    return {
      ref: `origin/main ${git(['rev-parse', '--short', 'origin/main'])}`,
      branches: manifest.stack.map((entry) => entry.branch),
      entries: manifest.stack
    }
  } catch {
    return null
  }
}
const stack = podStack()

function hardware(machine) {
  if (!machine) {
    return null
  }
  return `${machine.model}, ${machine.chip} (${machine.cores} cores: ${machine.performanceCores} performance + ${machine.efficiencyCores} efficiency), ${machine.memoryGB} GB, macOS ${machine.macOS}`
}

// A change is in Pod when the manifest lists its branch, its upstream PR, or replays the branch
// under another name (the entry's note names it).
function inPodStack(row) {
  if (!row.branch || !stack) {
    return null
  }
  return stack.entries.some(
    (entry) =>
      entry.branch === row.branch ||
      (row.upstream && entry.upstream === row.upstream) ||
      (entry.note ?? '').includes(row.branch)
  )
}

function rowCaveats(suite, row) {
  const caveats = [...(suite.caveats ?? []), ...(row.caveats ?? [])]
  const carried = inPodStack(row)
  if (carried !== null) {
    const change = row.upstream ? `${row.branch} (${row.upstream})` : row.branch
    caveats.push(
      carried
        ? `From ${change}, which Pod's stack carries (${stack.ref}).`
        : `From ${change}, which Pod's stack does not carry yet (${stack.ref}).`
    )
  }
  return caveats
}

const metrics = []
const comparisons = []
for (const suite of suites) {
  const fresh = {
    kind: 'fresh',
    date: suite.writtenAt?.slice(0, 10) ?? null,
    source: path.join(path.relative(BENCH_ROOT, dir), suite.file)
  }
  const byId = new Map()
  for (const row of suite.metrics ?? []) {
    const entry = {
      id: row.id,
      suite: suite.suite,
      group: row.group ?? suite.group ?? 'pod',
      subject: row.subject,
      metric: row.metric,
      unit: row.unit,
      better: row.better,
      n: row.stats?.n ?? null,
      median: row.stats?.median ?? null,
      p95: row.stats?.p95 ?? null,
      min: row.stats?.min ?? null,
      max: row.stats?.max ?? null,
      extra: row.extra ?? null,
      conditions: row.conditions,
      provenance: row.provenance ?? fresh,
      branch: row.branch ?? null,
      upstream: row.upstream ?? null,
      inPodStack: inPodStack(row),
      caveats: rowCaveats(suite, row),
      source: suite.file
    }
    metrics.push(entry)
    byId.set(row.id, entry)
  }
  // Orca vs Pod pairs share an id prefix: <suite>.<...>.orca vs <suite>.<...>.pod-*.
  const automatic = [...byId.keys()]
    .filter((id) => id.endsWith('.orca'))
    .flatMap((id) =>
      ['pod-native', 'pod-xterm', 'pod']
        .map((pod) => `${id.slice(0, -'orca'.length)}${pod}`)
        .filter((candidate) => byId.has(candidate))
        .map((candidate) => ({ baseline: id, candidate }))
    )
  for (const pair of [...(suite.comparisons ?? []), ...automatic]) {
    const baseline = byId.get(pair.baseline)
    const candidate = byId.get(pair.candidate)
    const b = baseline?.median
    const c = candidate?.median
    if (!Number.isFinite(b) || !Number.isFinite(c) || b === 0 || c === 0) {
      continue
    }
    const factor = baseline.better !== 'higher' ? b / c : c / b
    comparisons.push({
      group: candidate.group,
      suite: suite.suite,
      metric: candidate.metric,
      label: pair.label ?? null,
      baseline: { id: pair.baseline, subject: baseline.subject, median: b },
      candidate: { id: pair.candidate, subject: candidate.subject, median: c },
      unit: candidate.unit,
      // >1: the candidate is ahead by this factor; <1: behind.
      factor: Number(factor.toFixed(3)),
      candidateAhead: factor > 1,
      provenance:
        baseline.provenance.kind === 'historical' || candidate.provenance.kind === 'historical'
          ? candidate.provenance
          : fresh,
      caveats: [...new Set([...baseline.caveats, ...candidate.caveats])]
    })
  }
}

const machine = suites.find((suite) => suite.machine)?.machine ?? null
const summary = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  resultsDir: path.relative(BENCH_ROOT, dir),
  methodology: METHODOLOGY,
  hardware: hardware(machine),
  machine,
  maxLoad: suites.find((suite) => suite.maxLoad)?.maxLoad ?? null,
  aggregation: suites.find((suite) => suite.aggregation)?.aggregation ?? null,
  podStack: stack,
  caveats: GLOBAL_CAVEATS,
  groups: {
    pod: 'Pod vs Orca and other terminals, measured in this run',
    'claude-acc': 'claude-acc, which ships inside Pod: re-measured rows plus historical ones'
  },
  suites: Object.fromEntries(
    suites.map((suite) => [
      suite.suite,
      {
        file: suite.file,
        writtenAt: suite.writtenAt,
        group: suite.group ?? 'pod',
        versions: suite.versions,
        config: suite.config,
        caveats: suite.caveats ?? []
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
