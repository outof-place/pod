// Fresh claude-acc measurements of tools and hooks: each "before" runs in a temporary copy,
// environment or clone, never in the user's live settings. Called by suites/claude-acc.mjs.
import { execFile, spawn } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { collectSamples, commandVersion, sleep } from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const run = promisify(execFile)

export async function timed(program, args, opts = {}) {
  const t0 = process.hrtime.bigint()
  await run(program, args, { maxBuffer: 256 * 1024 * 1024, ...opts })
  return Number(process.hrtime.bigint() - t0) / 1e6
}

export function feed(program, args, input, env) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(program, args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6))
    child.stdin.end(input)
  })
}

/** Interleaved before/after samples (each gated on load), as two summarized rows and a comparison. */
export function beforeAfterOf({ runs, historical, metrics, comparisons }) {
  return async function beforeAfter({
    id,
    item,
    before,
    after,
    conditions,
    unit = 'ms',
    caveats = [],
    area = null,
    metric = null,
    better = null
  }) {
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
    // Items without a published historical number name their own area and metric.
    const historicalMeta = historical.items.find((entry) => entry.id === `claude-acc.${item}`)
    const meta = {
      area: area ?? historicalMeta?.area ?? 'claude-acc',
      metric: metric ?? historicalMeta?.metric ?? id,
      better: better ?? historicalMeta?.better ?? 'lower'
    }
    for (const [side, definition] of [
      ['before', before],
      ['after', after]
    ]) {
      metrics.push({
        id: `claude-acc.${item}.${side}`,
        group: 'claude-acc',
        subject: definition.subject,
        metric: `${meta.area}: ${meta.metric}`,
        unit,
        better: meta.better,
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
      label: `${meta.area}: ${meta.metric}`
    })
    return samples
  }
}

export async function measureTools(ctx) {
  const { wanted, metrics, versions, fresh, beforeAfter, ACC_STATE, PORTIVO } = ctx
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
        caveats: [
          'A fresh clone has none of the untracked and ignored files of a working checkout.'
        ]
      })
    } finally {
      await git(['fsmonitor--daemon', 'stop']).catch(() => {})
      rmSync(clone, { recursive: true, force: true })
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
}
