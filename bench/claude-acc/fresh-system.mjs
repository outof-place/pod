// Fresh claude-acc measurements of the janitor's compression, Gatekeeper's first-exec check and
// the build scheduler, each against copies, launchd jobs or a temporary HOME. Called by
// suites/claude-acc.mjs.
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { collectSamples, commandVersion, sleep } from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const run = promisify(execFile)

export async function measureSystem(ctx) {
  const { wanted, runs, metrics, versions, fresh, beforeAfter, ACC_STATE, HOME, schedJobs } = ctx
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
            // The originals may already be compressed by the janitor; start from plain copies.
            await run('/opt/homebrew/bin/afsctool', ['-d', dir])
            const before = allocatedKB(dir)
            await run('/opt/homebrew/bin/afsctool', ['-c', '-T', 'LZFSE', '-J4', dir])
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

  if (wanted('compress-apps')) {
    // Decompressed copies of a fixed set of user-owned app bundles, compressed the way the janitor's
    // compress task does; the apps themselves are not touched.
    const APPS = [
      'Ghostty.app',
      'Orca.app',
      'Linear.app',
      'Notion.app',
      'Figma.app',
      'Discord.app',
      'Signal.app'
    ]
    const apps = APPS.map((name) => path.join('/Applications', name)).filter(
      (app) => existsSync(app) && statSync(app).uid === process.getuid()
    )
    const allocatedKB = (dir) =>
      Number(execFileSync('/usr/bin/du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0])
    const results = []
    for (const app of apps) {
      const [sample] = await collectSamples({
        label: `claude-acc compress-apps ${path.basename(app)}`,
        count: 1,
        measure: async () => {
          const dir = mkdtempSync(path.join(os.tmpdir(), 'pod-bench-apps-'))
          const copy = path.join(dir, path.basename(app))
          try {
            await run('/usr/bin/ditto', [app, copy])
            // The janitor may have compressed the original already; start from a plain copy.
            await run('/opt/homebrew/bin/afsctool', ['-d', copy])
            const before = allocatedKB(copy)
            await run('/opt/homebrew/bin/afsctool', ['-c', '-T', 'LZFSE', '-J4', copy])
            const after = allocatedKB(copy)
            return {
              app: path.basename(app),
              beforeKB: before,
              afterKB: after,
              savedPercent: 100 * (1 - after / before)
            }
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }
      })
      results.push(sample)
    }
    const totalBefore = results.reduce((sum, r) => sum + r.beforeKB, 0) / 1024
    const totalAfter = results.reduce((sum, r) => sum + r.afterKB, 0) / 1024
    metrics.push({
      id: 'claude-acc.janitor.compress-apps.after',
      group: 'claude-acc',
      subject: 'APFS LZFSE (afsctool -c -T LZFSE, as janitor compress runs it)',
      metric: 'Janitor: space saved on app bundles by APFS compression',
      unit: '%',
      better: 'higher',
      stats: summarize(
        results.map((r) => r.savedPercent),
        '%'
      ),
      extra: {
        apps: results.map((r) => r.app),
        totalBeforeMB: Math.round(totalBefore),
        totalAfterMB: Math.round(totalAfter)
      },
      conditions: `decompressed copies of ${results.length} user-owned apps from /Applications, one sample per app, allocated size from du -sk`
    })
    fresh['compress-apps'] = results
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
        area: 'perf-root',
        metric: 'first exec of a freshly built Go binary',
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
    const JOBS = schedJobs
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
        area: 'Build scheduler',
        metric: 'total wait of Go builds submitted at once',
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
}
