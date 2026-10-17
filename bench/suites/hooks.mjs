// Claude Code hook cost: the hook each app installs for the installed `claude`, replayed over
// recorded hook payloads one event at a time, as Claude runs a command hook.
//   cpu        user+system CPU of the hook's whole process tree, per event
//   processes  processes the hook's tree started per event (the hook itself included)
//   wall       spawn to exit and stdout EOF, per event (how long the hook process lives)
//   blocking   the part of wall Claude waits for, per event: 0 for a hook installed `async`
//
// Each app's installer is its own bundled JavaScript (lib/hook-install.cjs), run against a
// throwaway HOME with the claude version read from the install path (claude itself never runs).
// Every hook posts to one loopback stub that answers as the runtime's hook server does (204 after
// the body), so the rows cover the hook process and its request, not the runtime's handling.
//
//   node bench/suites/hooks.mjs [--replays 6] [--gap-ms 25]
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { extractAsar } from '../lib/asar.mjs'
import { assertRealHomeUntouched, realHomeState } from '../lib/real-home-guard.mjs'
import { assertHeavyGate } from '../lib/heavy-gate.mjs'
import {
  BENCH_ROOT,
  TOOLS_BIN,
  collectSamples,
  log,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { ORCA_APP, POD_APP, PROFILE_BASE, describeApp } from '../lib/orca-instance.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    replays: { type: 'string', default: '6' },
    'gap-ms': { type: 'string', default: '25' }
  }
})
const replays = Number(options.replays)
const gapMs = Number(options['gap-ms'])
const SUITE = 'hooks'

// Hook payloads Claude Code wrote to a stdin-capture hook over a real PTY, committed as test
// fixtures with the same blob in both repos (src/shared/__fixtures__/, Pod and Orca).
const RECORDINGS = [
  { file: 'claude-cancel-shell-hooks.jsonl', blob: 'df4b6a43ce88dd85b5058f2c0f0f18fd42571d5c', claude: '2.1.280' },
  { file: 'claude-cancel-subagent-hooks.jsonl', blob: '436e494739ffd09ca981ec8b11dafa51ae815af0', claude: '2.1.280' },
  { file: 'claude-task-notification-hooks.jsonl', blob: '6b974cfa52d35465cc3fc77275bf8fbb0159e926', claude: '2.1.287' }
]

// The installed claude's version from its install path (~/.local/bin/claude -> versions/<v>).
function claudeVersion() {
  if (process.env.POD_BENCH_CLAUDE_VERSION) {
    return process.env.POD_BENCH_CLAUDE_VERSION
  }
  const target = readlinkSync(path.join(os.homedir(), '.local/bin/claude'))
  const version = path.basename(target)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`cannot read the claude version from ${target}: set POD_BENCH_CLAUDE_VERSION`)
  }
  return version
}

function recordedPayloads() {
  const payloads = []
  for (const recording of RECORDINGS) {
    const text = execFileSync('git', ['-C', path.dirname(BENCH_ROOT), 'cat-file', 'blob', recording.blob], {
      encoding: 'utf8',
      maxBuffer: 16 << 20
    })
    for (const line of text.trim().split('\n')) {
      const record = JSON.parse(line)
      if (record.kind === 'hook') {
        payloads.push({ recording: recording.file, event: record.payload.hook_event_name, json: JSON.stringify(record.payload) })
      }
    }
  }
  return payloads
}

assertHeavyGate('the hooks suite')
const version = claudeVersion()
// Under the run's own /private/tmp dir (run-final.sh's base, else this process's own).
mkdirSync(path.dirname(PROFILE_BASE), { recursive: true })
const runDir = mkdtempSync(path.join(path.dirname(PROFILE_BASE), 'hooks-'))
log(`hooks: run dir ${runDir}, claude ${version}`)

// One loopback receiver for both apps, answering as the runtime's hook server does.
const received = []
const token = randomUUID()
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    received.push({
      ok: req.method === 'POST' && req.url === '/hook/claude' && req.headers['x-orca-agent-hook-token'] === token,
      contentType: req.headers['content-type'] ?? null,
      sha1: createHash('sha1').update(body).digest('hex')
    })
    res.writeHead(204)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// Installs one app's hooks into its own throwaway HOME and returns how Claude would run each event.
function installApp(name, appPath) {
  const dir = path.join(runDir, name)
  const home = path.join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const asarDir = path.join(dir, 'asar')
  extractAsar(path.join(appPath, 'Contents/Resources/app.asar'), asarDir)
  const bundledHook = path.join(appPath, 'Contents/Resources/bin/pod-agent-hook')
  const out = execFileSync(process.execPath, [path.join(BENCH_ROOT, 'lib/hook-install.cjs'), asarDir, version], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      // In the app the copy source is process.resourcesPath/bin; plain Node has no resourcesPath.
      ...(name === 'pod' ? { POD_AGENT_HOOK_BINARY: bundledHook } : {})
    }
  })
  const installed = JSON.parse(out.trim().split('\n').pop())
  const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8'))
  const events = {}
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const hooks = groups.flatMap((group) => group.hooks.map((hook) => ({ ...hook, matcher: group.matcher ?? null })))
    if (hooks.length !== 1) {
      throw new Error(`${name}: expected one managed hook for ${event}, found ${hooks.length}`)
    }
    const [hook] = hooks
    events[event] = {
      // Exec form (args) runs the command with no shell; shell form runs it through /bin/sh -c.
      argv: Array.isArray(hook.args) ? [hook.command, ...hook.args] : ['/bin/sh', '-c', hook.command],
      form: Array.isArray(hook.args) ? 'exec' : 'shell',
      async: hook.async === true,
      matcher: hook.matcher,
      timeout: hook.timeout
    }
  }
  const forms = new Set(Object.values(events).map((event) => JSON.stringify(event.argv)))
  if (forms.size !== 1) {
    throw new Error(`${name}: the managed hook command differs between events`)
  }
  // The endpoint file the runtime publishes (endpoint-publication.ts) and the pane env it sets.
  const endpoint = path.join(dir, 'userData/agent-hooks/endpoint.env')
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const endpointVars = {
    ORCA_AGENT_HOOK_PORT: String(port),
    ORCA_AGENT_HOOK_TOKEN: token,
    ORCA_AGENT_HOOK_ENV: 'production',
    ORCA_AGENT_HOOK_VERSION: '1',
    ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
    ORCA_AGENT_HOOK_OPENCODE_TUI: '1'
  }
  writeFileSync(endpoint, `${Object.entries(endpointVars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 })
  mkdirSync(path.join(dir, 'tmp'))
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: `${path.join(dir, 'tmp')}/`,
    LANG: 'en_US.UTF-8',
    ...endpointVars,
    ORCA_AGENT_HOOK_ENDPOINT: endpoint,
    ORCA_PANE_KEY: 'bench-tab:1',
    ORCA_TAB_ID: 'bench-tab',
    ORCA_WORKTREE_ID: 'bench-worktree',
    ORCA_AGENT_LAUNCH_TOKEN: randomUUID()
  }
  return { name, app: describeApp(appPath), chunk: installed.chunk, events, env, dir }
}

// The suite runs each app's own installer, which writes Claude's settings: the account's real
// files must come out of the run unchanged (lib/real-home-guard.mjs), or no row is written.
function checkRealHome(where, strict = {}) {
  try {
    const rewritten = assertRealHomeUntouched(realBefore, where, runDir, strict)
    if (rewritten.length > 0) {
      log(`hooks: rewritten with the same content ${where} (not by this run, whose writes would differ): ${rewritten.join(', ')}`)
    }
    return rewritten
  } catch (error) {
    throw new Error(`refusing to write rows: ${error.message}`)
  }
}
const realBefore = realHomeState()
const apps = [installApp('orca', ORCA_APP), installApp('pod', POD_APP)]
checkRealHome('during the installs', { strictMtime: true })
const payloads = recordedPayloads()
// Claude runs a hook only for the events installed; recorded events neither app installs are left out.
const replayed = payloads.filter((payload) => apps.every((app) => app.events[payload.event]))
const skipped = [...new Set(payloads.filter((payload) => !replayed.includes(payload)).map((payload) => payload.event))]
const payloadFile = path.join(runDir, 'payloads.jsonl')
writeFileSync(payloadFile, `${replayed.map((payload) => payload.json).join('\n')}\n`)
log(`hooks: ${replayed.length} recorded events replayed, ${payloads.length - replayed.length} not installed (${skipped.join(', ')})`)

function replay(app) {
  const argv = Object.values(app.events)[0].argv
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(TOOLS_BIN, 'hookrun'), [payloadFile, String(gapMs), '--', ...argv], {
      env: app.env,
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out.trim().split('\n').map((line) => JSON.parse(line))) : reject(new Error(`hookrun exited ${code}`))))
  })
}

const events = { orca: [], pod: [] }
// Samples alternate the apps (orca, pod, pod, orca, ...) so drift in the machine's state lands on
// both; the first pair is a discarded warmup.
const order = Array.from({ length: replays + 1 }, (_, round) => (round % 2 === 0 ? ['orca', 'pod'] : ['pod', 'orca'])).flat()
const samples = await collectSamples({
  label: SUITE,
  count: replays * 2,
  warmup: 2,
  measure: async (index) => {
    const app = apps.find((candidate) => candidate.name === order[index])
    const first = received.length
    const rows = await replay(app)
    const posts = received.slice(first)
    // The hook must have taken its posting path for every event: one authenticated raw-JSON post
    // carrying the payload byte for byte, else the rows would time a different path.
    const expected = replayed.map((payload) => createHash('sha1').update(payload.json).digest('hex'))
    const delivered = posts.filter((post, i) => post.ok && post.contentType === 'application/json' && post.sha1 === expected[i]).length
    if (rows.length !== replayed.length || posts.length !== replayed.length || delivered !== replayed.length) {
      throw new Error(`${app.name}: ${rows.length} runs, ${posts.length} posts, ${delivered} delivered for ${replayed.length} events`)
    }
    // A process that outlives its hook would be counted only in part (outlivedCpuNs is a lower
    // bound: launchd may reap it first), so the rows assume none does.
    const outlived = rows.filter((row) => row.outlived > 0)
    if (outlived.length > 0) {
      throw new Error(`${app.name}: ${outlived.length} events left processes running after the hook exited`)
    }
    const failed = rows.filter((row) => row.status !== 0 || row.timedOut || row.stdout !== '{}\n')
    if (failed.length > 0) {
      throw new Error(`${app.name}: ${failed.length} hook runs failed, first ${JSON.stringify(failed[0])}`)
    }
    const perEvent = rows.map((row, i) => {
      const spec = app.events[replayed[i].event]
      // Pids are handed out in order: the next event's pid bounds this event's processes from above.
      const pidSpan = i + 1 < rows.length ? rows[i + 1].pid - row.pid : null
      return {
        event: replayed[i].event,
        cpuMs: (row.cpuNs + row.outlivedCpuNs) / 1e6,
        processes: row.processes,
        pidSpan: pidSpan !== null && pidSpan > 0 ? pidSpan : null,
        execs: row.execs,
        outlived: row.outlived,
        wallMs: row.wallUs / 1e3,
        blockingMs: spec.async ? 0 : row.wallUs / 1e3,
        bytes: row.bytes
      }
    })
    if (index >= 2) {
      events[app.name].push(...perEvent)
    }
    const mean = (field) => perEvent.reduce((sum, row) => sum + row[field], 0) / perEvent.length
    return { app: app.name, events: perEvent.length, cpuMsMean: mean('cpuMs'), blockingMsMean: mean('blockingMs'), wallMsMean: mean('wallMs'), perEvent }
  }
})
server.close()
const sameContentRewrites = checkRealHome('during the run')

const accepted = samples.filter((sample) => !sample.warmup)
// Named after what the installer actually wrote: the exec-form program, or the script a shell form runs.
function hookProgram(app) {
  const { argv, form } = Object.values(app.events)[0]
  return form === 'exec' ? path.basename(argv[0]) : (argv[2].match(/[\w.-]+\.sh\b/)?.[0] ?? 'a shell command')
}
const subject = (app) =>
  `${app.name === 'pod' ? 'Pod' : 'Orca'} ${app.app.version}: ${Object.values(app.events)[0].form}-form ${hookProgram(app)}`
const conditions = `${replays} replays of ${replayed.length} recorded events per app, one event at a time ${gapMs} ms apart, hooks installed for claude ${version}, loopback stub receiver`
const metrics = apps.flatMap((app) => {
  const rows = events[app.name]
  const perSample = accepted.filter((sample) => sample.app === app.name)
  const byEvent = Object.fromEntries(
    [...new Set(rows.map((row) => row.event))].map((event) => {
      const of = rows.filter((row) => row.event === event)
      return [event, { n: of.length, async: app.events[event].async, cpuMs: summarize(of.map((row) => row.cpuMs), 'ms'), processes: summarize(of.map((row) => row.processes), 'processes') }]
    })
  )
  const extra = {
    form: Object.values(app.events)[0].form,
    program: hookProgram(app),
    asyncEvents: Object.entries(app.events).filter(([, spec]) => spec.async).map(([event]) => event),
    cpuMsMean: Number((rows.reduce((sum, row) => sum + row.cpuMs, 0) / rows.length).toFixed(3)),
    pidSpanMin: Math.min(...rows.map((row) => row.pidSpan ?? Infinity)),
    outlived: rows.reduce((sum, row) => sum + row.outlived, 0),
    byEvent
  }
  return [
    { id: `${SUITE}.cpu.${app.name}`, subject: subject(app), metric: 'hook CPU per event', unit: 'ms', better: 'lower', stats: summarize(rows.map((row) => row.cpuMs), 'ms'), conditions, extra },
    { id: `${SUITE}.processes.${app.name}`, subject: subject(app), metric: 'processes per event', unit: 'processes', better: 'lower', stats: summarize(rows.map((row) => row.processes), 'processes'), conditions },
    { id: `${SUITE}.wall.${app.name}`, subject: subject(app), metric: 'hook process lifetime per event', unit: 'ms', better: 'lower', stats: summarize(rows.map((row) => row.wallMs), 'ms'), conditions },
    {
      id: `${SUITE}.blocking.${app.name}`,
      subject: subject(app),
      metric: 'time Claude waits for the hook, mean per event',
      unit: 'ms',
      better: 'lower',
      stats: summarize(perSample.map((sample) => sample.blockingMsMean), 'ms'),
      conditions: `${conditions}; one value per replay`
    }
  ]
})

writeSuiteResult(SUITE, {
  versions: Object.fromEntries(apps.map((app) => [app.name, app.app])),
  realHomeCheck: { files: Object.keys(realBefore).length, sameContentRewrites },
  config: { replays, gapMs, claudeVersion: version, events: replayed.length, notInstalled: skipped, recordings: RECORDINGS, installers: Object.fromEntries(
      apps.map((app) => {
        const { argv, form } = Object.values(app.events)[0]
        const events = Object.fromEntries(Object.entries(app.events).map(([event, { async, matcher, timeout }]) => [event, { async, matcher, timeout }]))
        return [app.name, { chunk: app.chunk, form, argv, events }]
      })
    )
  },
  caveats: [
    `Payloads: ${replayed.length} hook events Claude Code ${[...new Set(RECORDINGS.map((r) => r.claude))].join(' and ')} wrote over a real PTY, from the fixtures both repos carry (src/shared/__fixtures__/, blobs pinned in the suite). ${skipped.length ? `${skipped.join(', ')} events were recorded but neither app installs a hook for them, so Claude would run none.` : ''}`,
    `The hooks are what each app's own bundled installer writes for claude ${version}: ${apps
      .map((app) => `${app.name === 'pod' ? 'Pod' : 'Orca'} ${Object.values(app.events)[0].form === 'shell' ? `a shell-form command (Claude runs it through /bin/sh -c) that runs ${hookProgram(app)}` : `an exec-form ${hookProgram(app)} (no shell)`}`)
      .join(', ')}. Claude's own cost of starting the process is not in the rows.`,
    'Each hook ran with the suite\'s small, fixed environment (system PATH, the endpoint and pane variables). A real Claude hands a hook its whole environment and the project as cwd, and a pane\'s PATH usually puts Homebrew before /usr/bin, which can pick another curl.',
    'Both apps post to the same loopback stub, which reads the body and answers 204 like the runtime\'s hook server; the runtime\'s handling of the post is not in the rows. Every event was checked to arrive once, authenticated, as the raw payload.',
    'processes counts the tree through kqueue from a suspended start (a lower bound: a grandchild can exit unseen); pidSpanMin, the smallest gap between consecutive hook pids, bounds it from above.',
    'blocking is 0 for events a hook is installed async for: Claude Code does not wait for an async command hook (Claude Code hooks docs).'
  ],
  metrics,
  samples: samples.map(({ perEvent, ...sample }) => ({ ...sample, perEvent }))
})
log(`hooks: done; remove ${runDir} with pod-tmp-rm when the run is over`)
