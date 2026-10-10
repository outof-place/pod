// Pod's indexed search (ogd from pod-search) against ripgrep, through the two harnesses of the
// pod/search-client branch, at the SHAs bench/search/prepare.sh pinned:
//   engine  src/main/pod/search/ogd-ripgrep-parity.real-ogd.test.ts: each query through ogd and
//           through Orca's bundled rg, median of ORCA_OGD_PARITY_RUNS, and a result diff;
//   in-app  tests/e2e/pod-native-search.spec.ts: headless Pod UI, quick-open and text search from
//           the request to the first result row, rg vs ogd, gitignored shown and hidden.
// Each harness runs --invocations times (each gated on load); a row's samples are its medians.
//
//   node bench/suites/ogd.mjs --inputs search-inputs.json [--invocations 5]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { collectSamples, log, writeSuiteResult } from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    inputs: { type: 'string' },
    invocations: { type: 'string', default: '5' },
    'parity-runs': { type: 'string', default: '5' }
  }
})
const inputs = JSON.parse(readFileSync(options.inputs, 'utf8'))
if (!inputs.ogd || !inputs.searchClient) {
  throw new Error(
    'search inputs need ogd and searchClient (bench/search/prepare.sh --og-sha --search-client-sha)'
  )
}
const invocations = Number(options.invocations)

function runIn(cwd, command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => resolve({ code, output }))
  })
}

// The spec prints `[pod-native-search] {...}` with indented JSON; take the balanced object.
function markedJson(output, marker) {
  const start = output.indexOf(`${marker} {`)
  if (start === -1) {
    return null
  }
  let depth = 0
  const from = start + marker.length + 1
  for (let i = from; i < output.length; i += 1) {
    if (output[i] === '{') {
      depth += 1
    } else if (output[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(output.slice(from, i + 1))
      }
    }
  }
  return null
}

const metrics = []
const comparisons = []
const slug = (text) =>
  text
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()

// ---------- engine level ----------
const parity = await collectSamples({
  label: 'ogd engine parity',
  count: invocations,
  measure: async () => {
    const report = path.join(os.tmpdir(), `pod-bench-ogd-parity-${process.pid}-${Date.now()}.json`)
    const { code, output } = await runIn(
      inputs.searchClient,
      'pnpm',
      ['test', 'src/main/pod/search/ogd-ripgrep-parity.real-ogd.test.ts'],
      {
        ORCA_E2E_OGD_BIN: inputs.ogd,
        ORCA_OGD_PARITY_REPO: inputs.searchRepo,
        ORCA_OGD_PARITY_RUNS: options['parity-runs'],
        ORCA_OGD_PARITY_REPORT: report
      }
    )
    // An ogd without search.full_lines fails the test's first assertion by design: record it.
    if (!existsSync(report)) {
      return { failed: true, exit: code, outputTail: output.slice(-2000) }
    }
    const result = JSON.parse(readFileSync(report, 'utf8'))
    rmSync(report)
    return {
      exit: code,
      rg: result.rg,
      mismatches: result.mismatches,
      fallbacks: result.fallbacks ?? {},
      timings: result.timings
    }
  }
})
const suiteCaveats = []
const parityOk = parity.filter((sample) => !sample.failed)
if (parityOk.length < parity.length) {
  suiteCaveats.push(
    `The engine-level parity test failed without a report in ${parity.length - parityOk.length} of ${parity.length} invocations; its rows use the others.`
  )
}
const rgVersion = parityOk.find((sample) => sample.rg)?.rg ?? 'rg'
const mismatched = parityOk.some((sample) => Object.keys(sample.mismatches ?? {}).length > 0)
// ogd clips lines over 1 MiB. Pod's client declines a reply with a clipped line and asks rg
// instead, so for such a query Pod users get rg's time, not the ogd row's.
const fallbackLines = (label) =>
  Math.max(
    0,
    ...parityOk.map((sample) => sample.fallbacks[label.replace(/^search /, '')]?.length ?? 0)
  )
for (const label of Object.keys(parityOk[0]?.timings ?? {})) {
  const id = `ogd.engine.${slug(label)}`
  const conditions = `engine level, ${options['parity-runs']} runs per invocation, ${invocations} invocations, ${inputs.searchRepo} at ${inputs.searchRepoSha.slice(0, 9)}`
  const clipped = fallbackLines(label)
  const caveats = [
    ...(mismatched
      ? ['The parity check found differing results in at least one invocation (see ogd.json).']
      : []),
    ...(clipped > 0
      ? [
          `ogd clipped ${clipped} line(s) over 1 MiB in this query's answer. Pod's client declines such a reply and rg answers, so in Pod this query takes rg's time; the ogd row times ogd's own clipped answer and has no comparison.`
        ]
      : [])
  ]
  for (const engine of ['rg', 'ogd']) {
    metrics.push({
      id: `${id}.${engine}`,
      subject:
        engine === 'rg'
          ? `${rgVersion} (Orca's bundled ripgrep)`
          : `ogd (pod-search ${inputs.ogSha.slice(0, 9)})`,
      metric: `indexed search vs ripgrep: ${label}`,
      unit: 'ms',
      better: 'lower',
      stats: summarize(
        parityOk.map((sample) => sample.timings[label]?.[engine]),
        'ms'
      ),
      conditions,
      caveats,
      branch: 'pod/search-client'
    })
  }
  if (clipped === 0) {
    comparisons.push({ baseline: `${id}.rg`, candidate: `${id}.ogd`, label: `engine: ${label}` })
  }
}

// ---------- in app ----------
const app = await collectSamples({
  label: 'ogd in-app search',
  count: invocations,
  measure: async () => {
    const { code, output } = await runIn(
      inputs.searchClient,
      'pnpm',
      ['run', 'test:e2e', 'tests/e2e/pod-native-search.spec.ts', '--workers=1'],
      {
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_E2E_OGD_BIN: inputs.ogd,
        ORCA_E2E_OGD_REPO: inputs.searchRepo,
        SKIP_BUILD: '1'
      }
    )
    const result = markedJson(output, '[pod-native-search]')
    if (!result) {
      throw new Error(`pod-native-search printed no timings (exit ${code}): ${output.slice(-2000)}`)
    }
    return { exit: code, features: result.features, timings: result.timings }
  }
})
const appLabels = Object.keys(app[0]?.timings ?? {})
// What the daemon advertised decides what its rows measure: without these features the "ogd" rows
// time Orca's rg fallback (tests/e2e/pod-native-search.spec.ts), so they are left out.
const features = app[0]?.features ?? []
const hasAll = (names) => names.every((name) => features.includes(name))
const servesText = hasAll(['search.full_lines', 'search.max_filesize'])
const servesIgnoredPaths = hasAll(['fuzzy.ignored', 'files.ignored'])
const ogdMeasures = (label) =>
  label.includes(' search ')
    ? servesText
    : label.includes('gitignored shown')
      ? servesIgnoredPaths
      : true
if (!servesText) {
  suiteCaveats.push(
    'ogd did not advertise search.full_lines and search.max_filesize, so in-app text search ran on rg and has no ogd row.'
  )
}
if (!servesIgnoredPaths) {
  suiteCaveats.push(
    'ogd did not advertise fuzzy.ignored and files.ignored, so quick open with gitignored files shown ran on rg and has no ogd row.'
  )
}
// Keys look like `<mode> quick open "<q>"` or `<mode> search "<q>"`, mode rg|ogd (+ gitignored shown).
for (const label of appLabels.filter((key) => key.startsWith('rg'))) {
  const rest = label.replace(/^rg/, '')
  const ogdLabel = `ogd${rest}`
  const id = `ogd.app.${slug(rest)}`
  // Without the feature the "ogd" timing is the rg fallback: keep the rg row, drop the ogd one.
  const measured = ogdMeasures(ogdLabel)
  for (const [engine, key] of measured
    ? [
        ['rg', label],
        ['ogd', ogdLabel]
      ]
    : [['rg', label]]) {
    metrics.push({
      id: `${id}.${engine}`,
      subject:
        engine === 'rg'
          ? "Pod UI on ripgrep (Orca's search path)"
          : `Pod UI on ogd (pod-search ${inputs.ogSha.slice(0, 9)})`,
      metric: `in-app search, request to first result row:${rest}`,
      unit: 'ms',
      better: 'lower',
      stats: summarize(
        app.map((sample) => sample.timings[key]),
        'ms'
      ),
      conditions: `headless Electron from pod/search-client ${inputs.searchClientSha.slice(0, 9)}, median of 5 per invocation, ${invocations} invocations`,
      branch: 'pod/search-client'
    })
  }
  if (measured) {
    comparisons.push({ baseline: `${id}.rg`, candidate: `${id}.ogd`, label: `in app:${rest}` })
  }
}

log(`ogd: ${metrics.length} rows`)
writeSuiteResult('ogd', {
  caveats: [
    ...suiteCaveats,
    'ripgrep here is the one Orca bundles (what Orca users get); og forks rg 15.2.0. The index is built and warm before timing starts; indexing time is not in these numbers.',
    'The in-app rows come from a headless E2E build of pod/search-client, not from the signed Pod build.'
  ],
  versions: {
    ogSha: inputs.ogSha,
    ogFeatures: inputs.ogFeatures,
    searchClientSha: inputs.searchClientSha,
    searchRepoSha: inputs.searchRepoSha,
    rg: rgVersion,
    ogdFeatures: app[0]?.features ?? null
  },
  config: { invocations, parityRuns: Number(options['parity-runs']), inputs },
  metrics,
  comparisons,
  samples: { parity, app }
})
