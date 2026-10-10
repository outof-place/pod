// claude-acc, which ships inside Pod. Every run emits its historical numbers
// (bench/claude-acc/historical.json, provenance "historical": measured earlier, with the date and
// the source). With --fresh it also re-measures the ones that can be reproduced without touching
// the user's live settings: "before" always runs in a temporary copy, environment or launchd job.
//
//   node bench/suites/claude-acc.mjs [--fresh] [--only a,b] [--runs 9] [--sched-jobs 7]
//
// Fresh measurements (--only names): compile-cache, rg-threads, guard-hook, launcher-python,
// git-speed, compress, compress-apps, devtools, sched, hook-wait.
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { measureSystem } from '../claude-acc/fresh-system.mjs'
import { beforeAfterOf, measureTools } from '../claude-acc/fresh-tools.mjs'
import { BENCH_ROOT, commandVersion, log, writeSuiteResult } from '../lib/bench-session.mjs'

const HOME = os.homedir()
const { values: options } = parseArgs({
  options: {
    fresh: { type: 'boolean', default: false },
    only: { type: 'string' },
    runs: { type: 'string', default: '9' },
    'sched-jobs': { type: 'string', default: '7' }
  }
})
const runs = Number(options.runs)
const wanted = (name) => options.fresh && (!options.only || options.only.split(',').includes(name))
const historical = JSON.parse(
  readFileSync(path.join(BENCH_ROOT, 'claude-acc/historical.json'), 'utf8')
)
const ACC_STATE = path.join(HOME, '.local/share/claude-acc')
const PORTIVO = path.join(HOME, 'Documents/portivo-app/Untitled')

const metrics = []
const comparisons = []

// ---------- historical rows ----------

for (const item of historical.items) {
  const provenance = {
    kind: 'historical',
    date: item.date,
    source: `${historical.sources[item.source]}${item.commit ? `, added in commit ${item.commit}` : ''}`,
    note: item.note ?? null
  }
  for (const side of ['before', 'after']) {
    const value = item[side]
    if (!value) {
      continue
    }
    metrics.push({
      id: `${item.id}.historical.${side}`,
      group: 'claude-acc',
      subject: value.subject,
      metric: `${item.area}: ${item.metric}`,
      unit: item.unit,
      better: item.better,
      // A range in the source stays a range: no median is invented for it.
      stats: {
        unit: item.unit,
        n: null,
        median: value.median ?? null,
        p95: null,
        min: value.min ?? value.median ?? null,
        max: value.max ?? value.median ?? null
      },
      extra: value.note || item.role ? { note: value.note ?? null, role: item.role ?? null } : null,
      conditions: item.note ?? '',
      provenance,
      caveats:
        item.role === 'context'
          ? ['Context for a design choice, not a claude-acc improvement.']
          : []
    })
  }
  // A context row explains a design choice; it is not a before/after win, so it gets no comparison.
  if (item.before && item.after && item.role !== 'context') {
    comparisons.push({
      baseline: `${item.id}.historical.before`,
      candidate: `${item.id}.historical.after`,
      label: `${item.area}: ${item.metric} (historical, ${item.date})`
    })
  }
}

// ---------- fresh measurements ----------

const versions = {
  claudeAcc: commandVersion('/opt/homebrew/bin/brew', ['list', '--versions', 'claude-acc']),
  claudeAccSource: existsSync(path.join(ACC_STATE, 'source'))
    ? readFileSync(path.join(ACC_STATE, 'source'), 'utf8').trim()
    : null,
  node: process.version
}

const fresh = {}
if (options.fresh) {
  const ctx = {
    wanted,
    runs,
    metrics,
    versions,
    fresh,
    beforeAfter: beforeAfterOf({ runs, historical, metrics, comparisons }),
    ACC_STATE,
    PORTIVO,
    schedJobs: Number(options['sched-jobs']),
    HOME
  }
  await measureTools(ctx)
  await measureSystem(ctx)
}

log(`claude-acc: ${metrics.length} rows (${Object.keys(fresh).length} fresh measurements)`)
writeSuiteResult('claude-acc', {
  group: 'claude-acc',
  caveats: [
    'claude-acc ships inside Pod. Historical rows were measured on this Mac on the dates given, with Orca and up to nine Claude Code sessions running, and are not re-measured unless a fresh row of the same name exists.'
  ],
  versions,
  config: { fresh: options.fresh, only: options.only ?? null, runs },
  excluded: historical.excluded,
  metrics,
  comparisons,
  fresh
})
