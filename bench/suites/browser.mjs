// Browser commands as agents run them: each one a runtime RPC call, as `orca browser <command>` /
// `podx browser <command>` sends it, answered by the app through agent-browser on a local page in
// the worktree's browser tab. Times the call from connect to reply; the CLI's own process start is
// not included. Rows: snapshot, click, fill, get title, screenshot, and the first click after a
// navigation. Every call is checked for its effect; a call that did not act is counted, not timed.
//
//   node bench/suites/browser.mjs [--rounds 20] [--passes 2] [--subjects orca,pod-native]
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { collectSamples, log, sleep, writeSuiteResult } from '../lib/bench-session.mjs'
import {
  SUBJECTS,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  openTerminal
} from '../lib/orca-instance.mjs'
import { rpcOk, runtimeMeta } from '../lib/runtime-rpc.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    rounds: { type: 'string', default: '20' },
    passes: { type: 'string', default: '2' },
    subjects: { type: 'string', default: 'orca,pod-native' }
  }
})
const rounds = Number(options.rounds)
const passes = Number(options.passes)
const names = options.subjects.split(',')

const TITLE = 'pod-bench browser page'
const LAST_ROW = 'Button 199'
// A page the size of a small app: 200 rows of buttons and links for the snapshot to walk.
const PAGE = `<!doctype html><html><head><title>${TITLE}</title></head><body>
<h1>Bench</h1><button id="b" onclick="window.clicks=(window.clicks||0)+1">Press</button>
<input id="t" aria-label="Text">
<main>${Array.from({ length: 200 }, (_, i) => `<p><button id="b${i}">Button ${i}</button> <a href="#r${i}">link ${i}</a> ${'text '.repeat(8)}</p>`).join('')}</main>
</body></html>`
const server = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const text = (reply) => JSON.stringify(reply.frame.result ?? null)
// `acted` says whether the call did its job: from the reply, or from the page state after the
// round's commands (clicks counted by the page, the input's value).
const ROWS = {
  snapshot: {
    metric: 'snapshot',
    method: 'browser.snapshot',
    params: () => ({}),
    acted: ({ reply }) => text(reply).includes(LAST_ROW)
  },
  click: {
    metric: 'click',
    method: 'browser.click',
    params: () => ({ element: '#b' }),
    acted: ({ state }) => state.clicks === 1
  },
  fill: {
    metric: 'fill',
    method: 'browser.fill',
    params: (round) => ({ element: '#t', value: `v${round}` }),
    acted: ({ state, round }) => state.value === `v${round}`
  },
  'get-title': {
    metric: 'get title',
    method: 'browser.get',
    params: () => ({ what: 'title' }),
    acted: ({ reply }) => text(reply).includes(TITLE)
  },
  screenshot: {
    metric: 'screenshot',
    method: 'browser.screenshot',
    params: () => ({}),
    // A blank or missing image is a few hundred bytes at most.
    acted: ({ reply }) => reply.bytes > 4096
  }
}
const AFTER_GOTO = { key: 'click-after-goto', metric: 'first click after a navigation' }

async function pageState(meta, worktree) {
  const reply = await rpcOk(meta, 'browser.eval', {
    worktree,
    expression:
      'JSON.stringify({ clicks: window.clicks ?? 0, value: document.querySelector("#t").value })'
  })
  return JSON.parse(reply.frame.result.result)
}

// The document's identity and load state; null while a navigation swaps it out.
async function documentState(meta, worktree) {
  try {
    const reply = await rpcOk(meta, 'browser.eval', {
      worktree,
      expression: 'performance.timeOrigin + "|" + document.readyState'
    })
    const [origin, readyState] = String(reply.frame.result.result).split('|')
    return { origin, readyState }
  } catch {
    return null
  }
}

async function loadedAfter(meta, worktree, previousOrigin) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const state = await documentState(meta, worktree)
    if (state && state.origin !== previousOrigin && state.readyState === 'complete') {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('goto never produced a loaded new document')
    }
    await sleep(20)
  }
}

// goto answers before the new document exists (it does not go through agent-browser).
async function navigate(meta, worktree, between = async () => {}) {
  const before = await documentState(meta, worktree)
  await rpcOk(meta, 'browser.goto', { url, worktree }, 60_000)
  await between()
  await loadedAfter(meta, worktree, before?.origin)
}

// One round: every command on a freshly loaded page, then the first click after a navigation,
// then whether a click sent the moment goto answers reaches the new page.
async function round(meta, worktree, index) {
  const sample = {}
  const replies = {}
  for (const [key, row] of Object.entries(ROWS)) {
    replies[key] = await rpcOk(meta, row.method, { worktree, ...row.params(index) })
    sample[`${key}Ms`] = replies[key].ms
  }
  const state = await pageState(meta, worktree)
  for (const [key, row] of Object.entries(ROWS)) {
    sample[`${key}Acted`] = row.acted({ reply: replies[key], state, round: index })
  }
  await navigate(meta, worktree)
  const click = await rpcOk(meta, 'browser.click', { worktree, element: '#b' })
  sample[`${AFTER_GOTO.key}Ms`] = click.ms
  sample[`${AFTER_GOTO.key}Acted`] = (await pageState(meta, worktree)).clicks === 1
  await navigate(meta, worktree, () => rpcOk(meta, 'browser.click', { worktree, element: '#b' }))
  sample.immediateClickLanded = (await pageState(meta, worktree)).clicks === 1
  // The next round starts from a fresh page, as this one did.
  await navigate(meta, worktree)
  return sample
}

// One instance: a tab on the page, then the rounds; the first warms agent-browser up and is not kept.
async function measureInstance(name, count) {
  const subject = SUBJECTS[name]
  const profile = createProfile({ experimentalNativeTerminal: subject.nativeTerminal })
  const instance = await launchInstance(subject.app, profile)
  try {
    await openTerminal(instance)
    const meta = runtimeMeta(profile)
    const { frame } = await rpcOk(meta, 'worktree.list', { limit: 10_000 })
    const tree = frame.result.worktrees.find(
      (entry) => entry.path === profile.repo || profile.repo.startsWith(entry.path)
    )
    const worktree = `id:${tree.id}`
    await rpcOk(meta, 'browser.tabCreate', { url, worktree }, 90_000)
    await loadedAfter(meta, worktree, null)
    return await collectSamples({
      label: `browser ${name}`,
      count,
      warmup: 1,
      measure: (index) => round(meta, worktree, index)
    })
  } finally {
    await closeInstance(instance)
  }
}

const samples = Object.fromEntries(names.map((name) => [name, []]))
const perPass = Math.ceil(rounds / passes)
for (let pass = 0; pass < passes; pass += 1) {
  // Alternate the order so neither app always runs first.
  for (const name of pass % 2 === 0 ? names : names.toReversed()) {
    const count = Math.min(perPass, rounds - samples[name].filter((s) => !s.warmup).length)
    if (count > 0) {
      samples[name].push(...(await measureInstance(name, count)))
    }
  }
}
server.close()

const metrics = []
const versions = {}
const caveats = [
  "Each time is one runtime RPC call from connect to reply, the request an agent's `orca browser` or `podx browser` command sends; the CLI's own process start is not included.",
  'Only calls that acted are timed: a click the page did not count, a fill that left another value, a snapshot without the last row, a title that did not match or a screenshot under 4 KiB is counted in `extra.acted` instead.',
  'Windowless instances with background throttling off; a screenshot of a window that is never on screen can differ from a visible one.'
]
const conditions = `windowless instance, background throttling off, local ${PAGE.length} byte page with 200 rows, one runtime RPC connection per command, ${rounds} rounds over ${passes} launches, first round of each launch discarded`
for (const name of names) {
  versions[name] = describeApp(SUBJECTS[name].app)
  const accepted = samples[name].filter((sample) => !sample.warmup)
  const label = SUBJECTS[name].label
  for (const [key, metric] of [
    ...Object.entries(ROWS).map(([key, row]) => [key, row.metric]),
    [AFTER_GOTO.key, AFTER_GOTO.metric]
  ]) {
    const acted = accepted.filter((sample) => sample[`${key}Acted`])
    if (acted.length < accepted.length) {
      caveats.push(
        `${label}: ${metric} did not act in ${accepted.length - acted.length} of ${accepted.length} rounds.`
      )
    }
    metrics.push({
      id: `browser.${key}.${name}`,
      subject: label,
      branch: SUBJECTS[name].branch,
      upstream: SUBJECTS[name].upstream,
      metric: `browser command: ${metric}`,
      unit: 'ms',
      better: 'lower',
      stats: summarize(
        acted.map((sample) => sample[`${key}Ms`]),
        'ms'
      ),
      extra: {
        acted: `${acted.length}/${accepted.length}`,
        ...(key === AFTER_GOTO.key
          ? {
              immediateClickLanded: `${accepted.filter((s) => s.immediateClickLanded).length}/${accepted.length}`
            }
          : {})
      },
      conditions
    })
  }
  const landed = accepted.filter((sample) => sample.immediateClickLanded).length
  if (landed < accepted.length) {
    caveats.push(
      `${label}: in ${accepted.length - landed} of ${accepted.length} rounds, a click sent as soon as goto answered did not reach the new page. The "first click after a navigation" row waits for the new page to load first.`
    )
  }
}
log('done')
writeSuiteResult('browser', {
  caveats,
  versions,
  config: {
    rounds,
    passes,
    subjects: names,
    url: 'http://127.0.0.1:<port>/',
    pageBytes: PAGE.length
  },
  metrics,
  samples
})
