// Checks every subject end to end before a long run: launch windowless with a throwaway profile,
// open a terminal through the app's own CLI, run a tiny termload workload, and quit. Fails fast
// when a new build breaks any link (CLI name, profile override, PTY geometry, query reply).
//
//   node bench/suites/preflight.mjs [--subjects orca,pod-native,pod-xterm]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { TOOLS_BIN, log, sleep, writeSuiteResult } from '../lib/bench-session.mjs'
import {
  SUBJECTS,
  cli,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  openTerminal,
  waitForPrompts
} from '../lib/orca-instance.mjs'

const { values: options } = parseArgs({
  options: { subjects: { type: 'string', default: 'orca,pod-native,pod-xterm' } }
})
const checks = {}
let failed = false
for (const name of options.subjects.split(',')) {
  const subject = SUBJECTS[name]
  const info = describeApp(subject.app)
  const check = { app: info, steps: [] }
  checks[name] = check
  const step = (label, detail = null) => {
    check.steps.push({ label, detail })
    log(`${name}: ${label}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
  }
  const profile = createProfile({
    experimentalNativeTerminal: subject.nativeTerminal,
    terminalCursorBlink: false
  })
  let instance = null
  try {
    if (!info.cli) {
      throw new Error('no CLI in the bundle (looked for bin/orca and bin/podx)')
    }
    instance = await launchInstance(subject.app, profile)
    step('launched', { firstWindowMs: instance.firstWindowAt - instance.spawnedAt })
    const handle = await openTerminal(instance)
    await waitForPrompts(profile, 1)
    step('terminal ready', { handle })
    const out = path.join(profile.ud, 'preflight.json')
    await cli(instance, [
      'terminal',
      'send',
      '--terminal',
      handle,
      '--text',
      `'${path.join(TOOLS_BIN, 'termload')}' --out '${out}' -- seq 1 10000`,
      '--enter'
    ])
    for (let i = 0; i < 600 && !existsSync(out); i += 1) {
      await sleep(50)
    }
    const result = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
    rmSync(out, { force: true })
    if (!result?.synced) {
      throw new Error('termload did not sync (no device-attributes reply)')
    }
    step('workload synced', {
      cols: result.cols,
      rows: result.rows,
      totalMs: result.totalMs,
      daReply: result.daReply
    })
    if (result.cols < 80 || result.rows < 24) {
      // Not fatal (throughput waits for the layout), but a real bug worth reporting.
      check.warnings = [
        ...(check.warnings ?? []),
        `PTY was ${result.cols}x${result.rows} once the first prompt was up`
      ]
      step('warning: tiny PTY at first prompt', { cols: result.cols, rows: result.rows })
    }
    if (subject.nativeTerminal) {
      const loaded = execFileSync('/usr/sbin/lsof', ['-p', String(instance.pid)], {
        encoding: 'utf8'
      }).includes('ghostty_terminal.node')
      step('native terminal addon loaded', { loaded })
      if (!loaded) {
        throw new Error('experimentalNativeTerminal is on but ghostty_terminal.node is not loaded')
      }
    }
    check.ok = true
  } catch (error) {
    check.ok = false
    check.error = String(error?.message ?? error)
    failed = true
    log(`${name}: FAILED ${check.error}`)
  } finally {
    if (instance) {
      await closeInstance(instance)
    }
  }
}
writeSuiteResult('preflight', { checks, metrics: [] })
process.exit(failed ? 1 : 0)
