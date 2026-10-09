// claude-acc, which ships inside Pod. Every run emits its historical numbers
// (bench/claude-acc/historical.json, provenance "historical": measured earlier, with the date and
// the source). With --fresh it also re-measures the ones that can be reproduced without touching
// the user's live settings: "before" always runs in a temporary copy, environment or launchd job.
//
//   node bench/suites/claude-acc.mjs [--fresh] [--only a,b] [--runs 9] [--sched-jobs 7]
//
// Fresh measurements (--only names): compile-cache, rg-threads, guard-hook, launcher-python,
// git-speed, compress, devtools, sched, hook-wait.
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  BENCH_ROOT,
  collectSamples,
  commandVersion,
  log,
  sleep,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const run = promisify(execFile)
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

async function timed(program, args, opts = {}) {
  const t0 = process.hrtime.bigint()
  await run(program, args, { maxBuffer: 256 * 1024 * 1024, ...opts })
  return Number(process.hrtime.bigint() - t0) / 1e6
}

function feed(program, args, input, env) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(program, args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6))
    child.stdin.end(input)
  })
}

/** Interleaved before/after samples (each gated on load), as two summarized rows and a comparison. */
async function beforeAfter({ id, item, before, after, conditions, unit = 'ms', caveats = [] }) {
  const samples = await collectSamples({
    label: `claude-acc ${id}`,
    count: runs,
    warmup: 1,
    measure: async (index) => {
      // Alternate the order so neither side always runs on a warmer cache.
      const [first, second] = index % 2 === 0 ? [before, after] : [after, before]
      const a = await first.measure()
      const b = await second.measure()
      return first === before ? { before: a, after: b } : { before: b, after: a }
    }
  })
  const accepted = samples.filter((sample) => !sample.warmup)
  const meta = historical.items.find((entry) => entry.id === `claude-acc.${item}`)
  for (const [side, definition] of [
    ['before', before],
    ['after', after]
  ]) {
    metrics.push({
      id: `claude-acc.${item}.${side}`,
      group: 'claude-acc',
      subject: definition.subject,
      metric: `${meta?.area ?? 'claude-acc'}: ${meta?.metric ?? id}`,
      unit,
      better: meta?.better ?? 'lower',
      stats: summarize(
        accepted.map((sample) => sample[side]),
        unit
      ),
      conditions,
      caveats
    })
  }
  comparisons.push({
    baseline: `claude-acc.${item}.before`,
    candidate: `claude-acc.${item}.after`,
    label: `${meta?.area ?? 'claude-acc'}: ${meta?.metric ?? id}`
  })
  return samples
}

const fresh = {}

if (wanted('compile-cache')) {
  // perf.py typescript_load: the same require, without and with NODE_COMPILE_CACHE.
  const typescript = globSync(
    `${PORTIVO}/node_modules/.pnpm/typescript@[1-6]*/node_modules/typescript`
  )
    .map((dir) => realpathSync(dir))
    .sort()
    .at(-1)
  const cache = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-ncc-'))
  const plain = { ...process.env }
  delete plain.NODE_COMPILE_CACHE
  const cached = { ...plain, NODE_COMPILE_CACHE: cache }
  const code = `require(${JSON.stringify(typescript)})`
  await timed(process.execPath, ['-e', code], { env: cached })
  fresh['compile-cache'] = await beforeAfter({
    id: 'compile-cache',
    item: 'ultra.node-compile-cache',
    before: {
      subject: 'no compile cache',
      measure: () => timed(process.execPath, ['-e', code], { env: plain })
    },
    after: {
      subject: 'NODE_COMPILE_CACHE (a temporary cache dir)',
      measure: () => timed(process.execPath, ['-e', code], { env: cached })
    },
    conditions: `node ${process.version}, require(${path.relative(PORTIVO, typescript)})`
  })
  rmSync(cache, { recursive: true, force: true })
}

if (wanted('rg-threads')) {
  const queries = [
    'useState',
    'process.env',
    'throw new Error',
    'console.error',
    'async function',
    'className='
  ]
  const search = (threads) => async () => {
    let total = 0
    for (const query of queries) {
      total += await timed('rg', ['--no-config', ...threads, '-n', '-F', '-e', query, '.'], {
        cwd: PORTIVO
      }).catch((error) => (error.code === 1 ? 0 : Promise.reject(error)))
    }
    return total / queries.length
  }
  fresh['rg-threads'] = await beforeAfter({
    id: 'rg-threads',
    item: 'ultra.rg-threads',
    before: { subject: 'rg, default threads', measure: search([]) },
    after: { subject: 'rg --threads=4 (rg-threads)', measure: search(['--threads=4']) },
    conditions: `${commandVersion('rg')}, mean of ${queries.length} literal searches per sample over ${PORTIVO}`
  })
}

if (wanted('guard-hook')) {
  // A Bash PreToolUse payload for a command the guard has no business with, as most are.
  const payload = JSON.stringify({
    session_id: 'pod-bench',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    cwd: os.tmpdir()
  })
  const env = { ...process.env, SCHED_OFF: '1' }
  const python = path.join(ACC_STATE, 'python')
  const many = (program, args) => async () => {
    let total = 0
    for (let i = 0; i < 10; i += 1) {
      total += await feed(program, args, payload, env)
    }
    return total / 10
  }
  fresh['guard-hook'] = await beforeAfter({
    id: 'guard-hook',
    item: 'ultra.guard-hook-native',
    before: {
      subject: 'devguard.py admit (Python)',
      measure: many(python, [path.join(ACC_STATE, 'devguard.py'), 'admit'])
    },
    after: {
      subject: 'claude-acc-hook (native)',
      measure: many(path.join(ACC_STATE, 'claude-acc-hook'), [])
    },
    conditions:
      'mean of 10 calls per sample, a PreToolUse payload for `ls -la`, the installed claude-acc'
  })
}

if (wanted('launcher-python')) {
  const many = (program) => async () => {
    let total = 0
    for (let i = 0; i < 10; i += 1) {
      total += await timed(program, ['-I', '-c', 'pass'])
    }
    return total / 10
  }
  versions.launcherPython = commandVersion(path.join(ACC_STATE, 'python'), ['-V'])
  versions.systemPython = commandVersion('/usr/bin/python3', ['-V'])
  fresh['launcher-python'] = await beforeAfter({
    id: 'launcher-python',
    item: 'ultra.launcher-python',
    before: {
      subject: `/usr/bin/python3 (${versions.systemPython})`,
      measure: many('/usr/bin/python3')
    },
    after: {
      subject: `claude-acc's python (${versions.launcherPython})`,
      measure: many(path.join(ACC_STATE, 'python'))
    },
    conditions: 'mean of 10 starts of `python -I -c pass` per sample'
  })
}

if (wanted('git-speed')) {
  // A temporary clone of Portivo (objects shared, files checked out), so the user's repo and its
  // config stay as they are.
  const clone = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-git-'))
  const git = (args, cwd = clone) => run('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 })
  const head = (await git(['rev-parse', 'HEAD'], PORTIVO)).stdout.trim()
  await git(['clone', '-q', '--shared', '--no-checkout', PORTIVO, clone], os.tmpdir())
  await git(['checkout', '-q', '--detach', head])
  const status = (config) => () =>
    timed('git', [...config, 'status', '--porcelain'], { cwd: clone })
  const off = ['-c', 'core.untrackedCache=false', '-c', 'core.fsmonitor=false']
  const on = ['-c', 'core.untrackedCache=true', '-c', 'core.fsmonitor=true']
  // The first statuses with the caches on write them and start the fsmonitor daemon.
  for (let i = 0; i < 3; i += 1) {
    await status(on)()
  }
  await sleep(2_000)
  const files = (await git(['ls-files'])).stdout.split('\n').filter(Boolean).length
  try {
    fresh['git-speed'] = await beforeAfter({
      id: 'git-speed',
      item: 'ultra.git-speed',
      before: { subject: 'default config', measure: status(off) },
      after: { subject: 'core.untrackedCache + core.fsmonitor', measure: status(on) },
      conditions: `${commandVersion('git')}, a temporary clone of Portivo at ${head.slice(0, 9)} (${files} files), plain \`git status --porcelain\``,
      caveats: ['A fresh clone has none of the untracked and ignored files of a working checkout.']
    })
  } finally {
    await git(['fsmonitor--daemon', 'stop']).catch(() => {})
    rmSync(clone, { recursive: true, force: true })
  }
}

if (wanted('compress')) {
  // Copies of the user's Claude Code transcripts in a temporary dir; the originals are not touched.
  const files = globSync(`${HOME}/.claude/projects/*/*.jsonl`)
    .map((file) => ({ file, stat: statSync(file) }))
    .filter(({ stat }) => Date.now() - stat.mtimeMs > 60 * 60_000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  const SET_BYTES = 64 * 2 ** 20
  const sets = []
  let current = []
  let size = 0
  for (const entry of files) {
    current.push(entry.file)
    size += entry.stat.size
    if (size >= SET_BYTES) {
      sets.push(current)
      current = []
      size = 0
      if (sets.length === runs) {
        break
      }
    }
  }
  const allocatedKB = (dir) =>
    Number(execFileSync('/usr/bin/du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0])
  const savings = []
  for (const [index, set] of sets.entries()) {
    const [sample] = await collectSamples({
      label: `claude-acc compress set ${index + 1}/${sets.length}`,
      count: 1,
      measure: async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-compress-'))
        try {
          for (const [i, file] of set.entries()) {
            copyFileSync(file, path.join(dir, `${i}.jsonl`))
          }
          const before = allocatedKB(dir)
          await run('/opt/homebrew/bin/afsctool', ['-c', '-T', 'LZFSE', '-j', '4', dir])
          const after = allocatedKB(dir)
          return {
            files: set.length,
            beforeKB: before,
            afterKB: after,
            savedPercent: 100 * (1 - after / before)
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    })
    savings.push(sample)
  }
  versions.afsctool = commandVersion('/opt/homebrew/bin/afsctool', ['-v'])
  metrics.push({
    id: 'claude-acc.janitor.compress-transcripts.after',
    group: 'claude-acc',
    subject: 'APFS LZFSE (afsctool -c -T LZFSE, as janitor compress runs it)',
    metric: 'Janitor: space saved on Claude Code transcripts by APFS compression',
    unit: '%',
    better: 'higher',
    stats: summarize(
      savings.map((sample) => sample.savedPercent),
      '%'
    ),
    conditions: `${savings.length} disjoint sets of ~64 MiB of transcripts (copies), allocated size from du -sk`
  })
  fresh.compress = savings
}

if (wanted('devtools')) {
  // perf.py first_exec: the first exec of a freshly built Go binary. One small Go timer starts the
  // target and reports the elapsed time, the same way in both arms: "before" from a launchd job
  // (no Developer Tools app behind it), "after" from this run's own responsible app.
  const work = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-gk-'))
  const goEnv = { ...process.env, SCHED_OFF: '1' }
  const build = async (dir, name, source) => {
    mkdirSync(path.join(work, dir), { recursive: true })
    writeFileSync(path.join(work, dir, 'go.mod'), `module ${dir}\n\ngo 1.21\n`)
    writeFileSync(path.join(work, dir, 'main.go'), source)
    await run(
      'go',
      ['build', '-C', path.join(work, dir), '-o', path.join(work, `${name}.bin`), '.'],
      {
        env: goEnv
      }
    )
    return path.join(work, `${name}.bin`)
  }
  const timer = await build(
    'timer',
    'timer',
    'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"os/exec"\n\t"time"\n)\n\nfunc main() {\n\tt0 := time.Now()\n\t_ = exec.Command(os.Args[1]).Run()\n\tos.WriteFile(os.Args[2], []byte(fmt.Sprint(time.Since(t0).Nanoseconds())), 0o644)\n}\n'
  )
  const target = () =>
    build(
      'target',
      `target-${process.hrtime.bigint()}`,
      `package main\n\nconst v = ${process.hrtime.bigint()}\n\nfunc main() { _ = v }\n`
    )
  const readMs = async (out) => {
    for (let i = 0; i < 600 && !existsSync(out); i += 1) {
      await sleep(50)
    }
    return Number(readFileSync(out, 'utf8')) / 1e6
  }
  const here = async () => {
    const out = path.join(work, `here-${process.hrtime.bigint()}`)
    await run(timer, [await target(), out])
    return readMs(out)
  }
  const launchd = async () => {
    const out = path.join(work, `launchd-${process.hrtime.bigint()}`)
    const label = `pod-bench.gatekeeper.${process.pid}.${Date.now()}`
    await run('/bin/launchctl', ['submit', '-l', label, '--', timer, await target(), out])
    try {
      return await readMs(out)
    } finally {
      await run('/bin/launchctl', ['remove', label]).catch(() => {})
    }
  }
  try {
    // The timer is itself a fresh binary: pay its own first exec in both contexts before measuring.
    await here()
    await launchd()
    fresh.devtools = await beforeAfter({
      id: 'devtools',
      item: 'perf-root.devtools',
      before: { subject: 'started by a launchd job (no Developer Tools app)', measure: launchd },
      after: { subject: "started from this run's own app (in Developer Tools)", measure: here },
      conditions: `${commandVersion('go', ['version'])}, first exec of a freshly built binary, timed by a small Go timer`,
      caveats: [
        'The Developer Tools exemption belongs to the app that started this run (Orca for the user).'
      ]
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (wanted('sched')) {
  // 7 Go builds submitted at once, each with its own empty GOCACHE: behind the old one-at-a-time
  // lock, and through sched.py in a temporary HOME (its own queue and history).
  const lib = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-sched-'))
  const home = path.join(lib, 'home')
  mkdirSync(home)
  const source = versions.claudeAccSource ?? ACC_STATE
  for (const file of ['sched.py', 'orcahost.py']) {
    if (existsSync(path.join(source, file))) {
      copyFileSync(path.join(source, file), path.join(lib, file))
    }
  }
  const module = path.join(lib, 'mod')
  mkdirSync(module)
  writeFileSync(path.join(module, 'go.mod'), 'module schedbench\n\ngo 1.21\n')
  for (let p = 0; p < 12; p += 1) {
    mkdirSync(path.join(module, `p${p}`))
    writeFileSync(
      path.join(module, `p${p}`, 'p.go'),
      `package p${p}\n\nimport (\n\t"encoding/json"\n\t"net/http"\n\t"text/template"\n)\n\nvar _ = json.Marshal\nvar _ = http.Get\nvar _ = template.New\n`
    )
  }
  const JOBS = Number(options['sched-jobs'])
  const job = (i, wrap) =>
    new Promise((resolve, reject) => {
      const startFile = path.join(lib, `start-${i}`)
      const command = `/usr/bin/perl -MTime::HiRes=time -e 'printf "%.6f", time' > '${startFile}'; GOCACHE='${path.join(lib, `cache-${i}-${Date.now()}`)}' go build -o /dev/null ./...`
      const submitted = Date.now() / 1000
      const child = spawn(wrap.program, wrap.args(command), {
        cwd: module,
        env: wrap.env,
        stdio: 'ignore'
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`job ${i} exited ${code}`))
        }
        resolve({
          submitted,
          started: Number(readFileSync(startFile, 'utf8')),
          ended: Date.now() / 1000
        })
      })
    })
  const lock = path.join(lib, 'lock')
  const plockWrap = {
    program: '/bin/sh',
    args: (command) => [
      '-c',
      `until mkdir '${lock}' 2>/dev/null; do sleep 0.1; done; trap "rmdir '${lock}'" EXIT; ${command}`
    ],
    env: { ...process.env, SCHED_OFF: '1' }
  }
  const python = existsSync(path.join(ACC_STATE, 'python'))
    ? path.join(ACC_STATE, 'python')
    : '/usr/bin/python3'
  const schedWrap = {
    program: python,
    args: (command) => [path.join(lib, 'sched.py'), 'run', '--via', 'cli', '--shell', command],
    env: Object.fromEntries(
      Object.entries({ ...process.env, HOME: home }).filter(
        ([key]) => key !== 'SCHED_OFF' && key !== 'CLAUDE_ACC_SCHED_JOB'
      )
    )
  }
  const queue = (wrap) => async () => {
    const results = await Promise.all(Array.from({ length: JOBS }, (_, i) => job(i, wrap)))
    return results.reduce((sum, r) => sum + Math.max(0, r.started - r.submitted), 0)
  }
  try {
    fresh.sched = await beforeAfter({
      id: 'sched',
      item: 'sched.overlap',
      unit: 's',
      before: { subject: 'one-at-a-time lock (mkdir lock, as plock)', measure: queue(plockWrap) },
      after: {
        subject: 'sched.py (memory-aware queue, temporary HOME)',
        measure: queue(schedWrap)
      },
      conditions: `${JOBS} \`go build ./...\` of a 12-package module submitted at once, each with an empty GOCACHE; total time the jobs waited before starting`
    })
  } finally {
    rmSync(lib, { recursive: true, force: true })
  }
}

if (wanted('hook-wait')) {
  // perf.py bench agents: the hook wait per tool call in the last 24 h of the user's transcripts.
  const source = versions.claudeAccSource ?? ACC_STATE
  const python = existsSync(path.join(ACC_STATE, 'python'))
    ? path.join(ACC_STATE, 'python')
    : '/usr/bin/python3'
  const { stdout } = await run(
    python,
    [
      '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(source)}); import perf; print(json.dumps(perf.bench_agents(24)["hooks"]))`
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }
  )
  const hooks = JSON.parse(stdout)
  for (const [event, stats] of Object.entries(hooks)) {
    metrics.push({
      id: `claude-acc.ultra.hook-wait-now.${event}`,
      group: 'claude-acc',
      subject: `${event} hooks, as configured now`,
      metric: 'Ultra: hook wait per tool call in the last 24 h of transcripts',
      unit: 'ms',
      better: 'lower',
      stats: {
        unit: 'ms',
        n: stats.n ?? null,
        median: stats.p50 ?? null,
        p95: null,
        min: null,
        max: null
      },
      extra: { p90: stats.p90 ?? null },
      conditions: '`claude-acc perf bench agents` over every session of the last 24 h',
      caveats: [
        'Claude Code times only hooks that print something, so silent hooks are not in this number.'
      ]
    })
  }
  fresh['hook-wait'] = hooks
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
