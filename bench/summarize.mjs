// Collects every suite's headline metrics in results/<date>/ into summary.json: per metric the
// median, p95, n, the versions measured, where the number comes from (provenance) and its caveats,
// plus the comparisons (who is ahead, by how much). Schema: bench/README.md#summaryjson.
//
//   node bench/summarize.mjs [results/<date>]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BENCH_ROOT, publicPaths } from './lib/bench-session.mjs'

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
const RUN_FILE = 'run.json'
const suites = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== 'summary.json' && file !== RUN_FILE)
  .map((file) => ({ file, ...JSON.parse(readFileSync(path.join(dir, file), 'utf8')) }))
// What run-final.sh benched: the Pod build and the commit it was built from, and the pinned
// search inputs. Absent for runs of single suites.
const runInfo = existsSync(path.join(dir, RUN_FILE))
  ? JSON.parse(readFileSync(path.join(dir, RUN_FILE), 'utf8'))
  : null

// Which topic branches Pod's product stack carries: pod-stack.json at the commit the benched Pod
// was built from (else origin/main), so a row that comes from a branch says whether it is in Pod.
function podStack(commit) {
  const git = (args) =>
    execFileSync('git', ['-C', path.dirname(BENCH_ROOT), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  const ref = commit ?? 'origin/main'
  try {
    const manifest = JSON.parse(git(['show', `${ref}:pod-stack.json`]))
    return {
      ref: `${commit ? 'Pod build commit' : 'origin/main'} ${git(['rev-parse', '--short', ref])}`,
      commit: git(['rev-parse', ref]),
      fromBuild: Boolean(commit),
      branches: manifest.stack.map((entry) => entry.branch),
      entries: manifest.stack
    }
  } catch {
    return null
  }
}
const stack = podStack(runInfo?.podCommit ?? null)

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
      // Every Pod row was measured on this build commit (run.json); its stack is podStack.
      podCommit:
        (row.group ?? suite.group ?? 'pod') === 'pod'
          ? stack?.fromBuild
            ? stack.commit
            : null
          : null,
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
  // The Pod build every pod-* row measured, and the pinned inputs of the search suites.
  run: runInfo,
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
  comparisons,
  // Rows this run could not measure yet (the og and ogd rows without a bench-ready pod-search).
  coming: runInfo?.coming ?? []
}
// summary.json is published: no row may cite a private note, and no string may carry a local path.
function publicSafetyProblems(value) {
  const problems = []
  const home = os.homedir()
  const visit = (node, where) => {
    if (typeof node === 'string') {
      if (node.includes(home) || node.includes(home.replaceAll('/', '-'))) {
        problems.push(`${where}: a local path`)
      }
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        visit(child, `${where}.${key}`)
      }
    }
  }
  visit(value, 'summary')
  const LOCAL = /(^|[\s(])(~\/|\/Users\/|\/private\/|\/var\/folders\/)|\.claude\//
  for (const [index, row] of [...value.metrics, ...value.comparisons].entries()) {
    for (const text of [row.provenance?.source, row.provenance?.note, row.extra?.note]) {
      if (typeof text === 'string' && (/memory/i.test(text) || LOCAL.test(text))) {
        problems.push(
          `row ${index} (${row.id ?? row.label}): source or note "${text.slice(0, 80)}" cites a private note or a local path`
        )
      }
    }
  }
  return problems
}

const publicSummary = JSON.parse(JSON.stringify(summary, publicPaths))
const problems = publicSafetyProblems(publicSummary)
if (problems.length > 0) {
  console.error(`summary.json not written: ${problems.length} problem(s)\n${problems.join('\n')}`)
  process.exit(1)
}
writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(publicSummary, null, 2)}\n`)
console.log(
  `summary: ${metrics.length} metrics, ${comparisons.length} comparisons -> ${path.join(dir, 'summary.json')}`
)
