// Visible-window suite: keystroke-to-pixels latency in every app, and (with --throughput) the
// throughput workloads in visible windows, including Ghostty, which has no windowless mode.
// Terminal.app is not a subject: driving it takes AppleScript against the user's own running
// Terminal by name, which a run never does (TEAM-START: no app activated or closed by name).
//
// Latency is measured the same way in every app by keylat:
//   - a CGEvent key is posted to the app's pid;
//   - ScreenCaptureKit captures a small region at the prompt at the display's refresh rate;
//   - the sample is the display time of the first frame in which the echoed glyph changed pixels.
// The shell is the same hermetic zsh everywhere, and cursor blink is off everywhere.
//
// This needs visible, focused windows, so it takes the desktop: run it only in a slot the user
// agreed to. Without --confirm-visible it only checks permissions and the detector (dry run).
//
//   node bench/suites/latency.mjs [--confirm-visible] [--throughput] [--rounds 5] [--keys 40]
//        [--subjects orca,pod-native,pod-xterm,ghostty] [--display ID]
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  TOOLS_BIN,
  appVersion,
  collectSamples,
  log,
  sleep,
  summarizeFields,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { APP_ENV_BLANK } from '../lib/guard-path.mjs'
import {
  SUBJECTS,
  cli,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  openTerminal,
  processSnapshot,
  removeProfile,
  snapshotProcesses,
  waitForPrompts,
  writePromptHook
} from '../lib/orca-instance.mjs'
import { runTree, stopRunTree } from '../lib/run-tree.mjs'
import { summarize } from '../lib/sample-stats.mjs'
import { ensureLogFile, measureWorkload, workloads } from '../lib/terminal-workloads.mjs'

const run = promisify(execFile)
const { values: options } = parseArgs({
  options: {
    'confirm-visible': { type: 'boolean', default: false },
    throughput: { type: 'boolean', default: false },
    rounds: { type: 'string', default: '5' },
    keys: { type: 'string', default: '40' },
    subjects: { type: 'string', default: 'orca,pod-native,pod-xterm,ghostty' },
    display: { type: 'string' }
  }
})
// Before anything starts: only these subjects. Terminal.app is refused by name, as every unknown one.
for (const name of options.subjects.split(',')) {
  if (name !== 'ghostty' && !SUBJECTS[name]) {
    throw new Error(
      name === 'terminal-app'
        ? 'refusing terminal-app: driving Terminal.app takes AppleScript against the user\'s own Terminal by name'
        : `unknown subject ${name}`
    )
  }
}
const keylat = path.join(TOOLS_BIN, 'keylat')
const keylatJSON = async (args) =>
  JSON.parse((await run(keylat, args, { maxBuffer: 16 * 1024 * 1024, timeout: 600_000 })).stdout)

const preflight = await keylatJSON(['--preflight'])
const selfTest = await keylatJSON(['--self-test'])
log('preflight', JSON.stringify(preflight))
if (!options['confirm-visible']) {
  log(
    `dry run: detector self-test ${selfTest.ok ? 'ok' : 'FAILED'}; pass --confirm-visible in an agreed slot to measure`
  )
  process.exit(selfTest.ok && preflight.screenCaptureAccess && preflight.postEventAccess ? 0 : 1)
}

const display = options.display
  ? preflight.displays.find((d) => String(d.id) === options.display)
  : preflight.displays.find((d) => d.main)
// Every window gets the same frame on the chosen display.
const frame = { x: display.bounds[0] + 80, y: display.bounds[1] + 80, width: 1100, height: 700 }
const GHOSTTY = '/Applications/Ghostty.app'
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
// The top-left of the terminal content: the prompt row after `clear`, and the row below.
const PROMPT_REGION = { width: 360, height: 48 }
// Title bar height of a standard macOS window, for apps whose content origin we cannot query.
const TITLE_BAR = 28
const logFile = options.throughput ? ensureLogFile() : null
const allWorkloads = logFile ? workloads(logFile) : {}

async function measureRegion(pid, rect) {
  const result = await keylatJSON([
    '--rect',
    rect.join(','),
    '--pid',
    String(pid),
    '--count',
    options.keys,
    '--display',
    String(display.id)
  ])
  return {
    misses: result.misses,
    keyToDisplayMs: summarize(
      result.samples.map((sample) => sample.keyToDisplayMs),
      'ms'
    ).median,
    perKey: result.samples.map((sample) => sample.keyToDisplayMs),
    frameIntervalMs: result.frameIntervalMs
  }
}

async function runWorkloads(start, snapshot, scratchDir) {
  const results = {}
  for (const [name, workload] of Object.entries(allWorkloads)) {
    results[name] = await measureWorkload({
      workload,
      out: path.join(scratchDir, `result-${name}.json`),
      start,
      snapshot
    })
  }
  return results
}

async function windowOf(pid) {
  for (let i = 0; i < 100; i += 1) {
    const { windows } = await keylatJSON(['--windows-of', String(pid)])
    if (windows.length > 0) {
      return windows[0].bounds
    }
    await sleep(100)
  }
  throw new Error(`no window for pid ${pid}`)
}

function regionBelowTitleBar(bounds) {
  return [
    bounds[0] - display.bounds[0] + 4,
    bounds[1] - display.bounds[1] + TITLE_BAR + 2,
    PROMPT_REGION.width,
    PROMPT_REGION.height
  ]
}

async function orcaSubject(name) {
  const subject = SUBJECTS[name]
  const profile = createProfile({
    experimentalNativeTerminal: subject.nativeTerminal,
    terminalCursorBlink: false
  })
  const instance = await launchInstance(subject.app, profile, { visible: true })
  try {
    await instance.app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setBounds(bounds)
      window.show()
      window.focus()
    }, frame)
    const handle = await openTerminal(instance)
    await waitForPrompts(profile, 1)
    const send = (text) =>
      cli(instance, ['terminal', 'send', '--terminal', handle, '--text', text, '--enter'])
    await send('clear')
    await keylatJSON(['--activate', String(instance.pid)])
    await sleep(1_500)
    const box = await instance.page.evaluate(() => {
      const rect = document.querySelector('.xterm-screen')?.getBoundingClientRect()
      return rect ? { left: rect.left, top: rect.top } : null
    })
    const content = await instance.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds()
    )
    const rect = [
      content.x + box.left - display.bounds[0],
      content.y + box.top - display.bounds[1],
      PROMPT_REGION.width,
      PROMPT_REGION.height
    ]
    const latency = { ...(await measureRegion(instance.pid, rect)), rect }
    const throughput = options.throughput
      ? await runWorkloads(send, () => processSnapshot(instance), profile.ud)
      : null
    return { ...latency, throughput }
  } finally {
    await closeInstance(instance)
  }
}

// A command queue the harness feeds through a file: Ghostty has no way to type into its shell
// from outside, so its throughput window runs this loop instead of an interactive prompt. A command
// it took is moved aside (queue.1, queue.2, …), never deleted.
function writeRunner(profile, queue) {
  const script = path.join(profile.ud, 'runner.zsh')
  writeFileSync(
    script,
    `n=0\nwhile :; do\n  if [[ -f '${queue}' ]]; then c=$(<'${queue}'); mv -f '${queue}' '${queue}'.$((n += 1)); eval "$c"; fi\n  sleep 0.05\ndone\n`
  )
  return script
}

// Ghostty: an APFS clone in the profile (its executable is then the run's own, so its processes
// are found and stopped by executable, never by argv), opened as a separate instance (open -n)
// with no user config, Orca's default font size (14).
function cloneGhostty(profile) {
  const clone = path.join(profile.ud, 'Ghostty.app')
  if (!clone.startsWith('/private/tmp/')) {
    throw new Error(`refusing to clone and re-sign Ghostty at ${clone}: only inside a run dir under /private/tmp`)
  }
  execFileSync('/bin/cp', ['-c', '-R', GHOSTTY, clone])
  // A quarantined clone would make `open` show a Gatekeeper dialog: this run's own clone only.
  execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', clone])
  // A bundle id of its own, re-signed ad hoc without the hardened runtime: cfprefsd keys a domain
  // by bundle id and account, never by HOME, so whatever the clone writes lands in
  // codes.pod.bench.ghostty, not in the account's Ghostty domain (the lead's MUST, 2026-10-17).
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', BENCH_GHOSTTY_ID, path.join(clone, 'Contents/Info.plist')])
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', clone], { stdio: ['ignore', 'ignore', 'pipe'] })
  const signed = execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1', 'sh', clone], { encoding: 'utf8' })
  if (!signed.includes(`\nIdentifier=${BENCH_GHOSTTY_ID}\n`)) {
    throw new Error(`the clone's signature does not carry ${BENCH_GHOSTTY_ID}`)
  }
  return clone
}

async function launchGhostty(profile, clone, command) {
  const config = path.join(profile.ud, `ghostty-${Date.now()}.conf`)
  writeFileSync(
    config,
    [
      'font-size = 14',
      'cursor-style-blink = false',
      'window-save-state = never',
      'confirm-close-surface = false',
      'quit-after-last-window-closed = true',
      // No Sparkle check, download or prompt (ghostty.org/docs/config/reference, auto-update).
      'auto-update = off',
      `window-position-x = ${frame.x}`,
      `window-position-y = ${frame.y}`,
      'window-width = 130',
      'window-height = 40',
      `command = ${command}`
    ].join('\n')
  )
  const exe = path.join(clone, 'Contents/MacOS/ghostty')
  // open hands the app its caller's environment: open-app.sh's allowlist instead (the profile's
  // HOME and TMPDIR, a system PATH), with the launchd session's SSH_AUTH_SOCK, USER, LOGNAME and
  // DISPLAY empty, and in the background (-g): only keylat --activate brings it forward.
  await run('/usr/bin/env', [
    '-i',
    `HOME=${profile.home}`,
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    `TMPDIR=${profile.tmp}`,
    'SHELL=/bin/zsh',
    'LANG=en_US.UTF-8',
    '/usr/bin/open',
    '-n',
    '-g',
    ...APP_ENV_BLANK.flatMap((name) => ['--env', `${name}=`]),
    clone,
    '--args',
    '--config-default-files=false',
    `--config-file=${config}`
  ])
  for (let i = 0; i < 100; i += 1) {
    const main = (await runTree(clone)).procs.find((proc) => proc.path === exe)
    if (main) {
      return main.pid
    }
    await sleep(100)
  }
  throw new Error('Ghostty did not start')
}

// The account's own Ghostty domain, which the re-id'd clone must leave alone: read before the
// first round and after the last, and shown in both results (the lead's rule, 2026-10-17). Hashes
// and mtimes only, never the contents.
const ACCOUNT_HOME = os.userInfo().homedir
const GHOSTTY_ID = 'com.mitchellh.ghostty'
const BENCH_GHOSTTY_ID = 'codes.pod.bench.ghostty'
function ghosttyAccountState(id = GHOSTTY_ID) {
  const sha = (data) => createHash('sha256').update(data).digest('hex')
  const file = (target) =>
    existsSync(target) ? { sha256: statSync(target).isFile() ? sha(readFileSync(target)) : null, mtimeMs: statSync(target).mtimeMs } : null
  let defaults = null
  try {
    // Through cfprefsd: it also sees what isn't flushed to the plist yet.
    defaults = sha(execFileSync('/usr/bin/defaults', ['export', id, '-'], { stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {}
  return {
    plist: file(path.join(ACCOUNT_HOME, 'Library/Preferences', `${id}.plist`)),
    defaultsExport: defaults,
    savedState: file(path.join(ACCOUNT_HOME, 'Library/Saved Application State', `${id}.savedState`))
  }
}

// Whether cfprefsd knows the clone's domain: `defaults read` fails for one that doesn't exist.
// Its output (the values) is never kept.
function benchDomainExists() {
  try {
    execFileSync('/usr/bin/defaults', ['read', 'codes.pod.bench.ghostty'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The clone's own traces in the account's Library (its preferences and saved state under
// codes.pod.bench.ghostty), a known leftover, after the last round. Only when this run created the
// domain (it didn't exist before the first round): `defaults delete` of exactly that domain, a
// literal here (the lead's OK, 2026-10-17), then the plist and saved state left on disk to the
// Trash. Returns what it did and the domain's state after.
function clearBenchTraces(existedBefore) {
  const existedAfter = benchDomainExists()
  let deleted = false
  if (!existedBefore && existedAfter) {
    execFileSync('/usr/bin/defaults', ['delete', 'codes.pod.bench.ghostty'], { stdio: 'ignore' })
    deleted = true
  }
  const trashed = []
  for (const trace of [
    path.join(ACCOUNT_HOME, 'Library/Preferences', `${BENCH_GHOSTTY_ID}.plist`),
    path.join(ACCOUNT_HOME, 'Library/Saved Application State', `${BENCH_GHOSTTY_ID}.savedState`)
  ]) {
    if (!existedBefore && existsSync(trace)) {
      execFileSync('/usr/bin/trash', [trace])
      trashed.push(trace.replace(ACCOUNT_HOME, '~'))
    }
  }
  return {
    existedBefore,
    existedAfter,
    deleted,
    trashed,
    existsAfterCleanup: benchDomainExists(),
    afterCleanup: ghosttyAccountState(BENCH_GHOSTTY_ID)
  }
}

// The clone's processes and their descendants (its shell), by executable (lib/run-tree.mjs).
async function stopGhostty(clone) {
  const { left } = await stopRunTree(clone)
  if (left.length > 0) {
    throw new Error(`Ghostty processes left: ${left.map((proc) => proc.pid).join(' ')}`)
  }
}

async function ghosttySubject() {
  const profile = createProfile()
  writePromptHook(profile)
  const env = `/usr/bin/env ZDOTDIR=${profile.zdot} POD_BENCH_PROMPT_LOG=${profile.promptLog}`
  const clone = cloneGhostty(profile)
  // `clear` first: login(1) may print a "Last login" line above the prompt.
  let pid = await launchGhostty(profile, clone, `/bin/sh -c "clear; exec ${env} /bin/zsh -i"`)
  try {
    await waitForPrompts(profile, 1)
    await keylatJSON(['--activate', String(pid)])
    const bounds = await windowOf(pid)
    await sleep(1_500)
    const rect = regionBelowTitleBar(bounds)
    const latency = { ...(await measureRegion(pid, rect)), rect }
    let throughput = null
    if (options.throughput) {
      await stopGhostty(clone)
      const queue = path.join(profile.ud, 'queue')
      pid = await launchGhostty(profile, clone, `/bin/zsh -f ${writeRunner(profile, queue)}`)
      await windowOf(pid)
      const runner = pid
      throughput = await runWorkloads(
        async (command) => writeFileSync(queue, command),
        () => snapshotProcesses(runner),
        profile.ud
      )
    }
    return { ...latency, throughput }
  } finally {
    try {
      await stopGhostty(clone)
    } finally {
      await removeProfile(profile)
      // The clone registered with LaunchServices when it opened: out again, as orca-instance does.
      try {
        execFileSync(LSREGISTER, ['-u', clone])
      } catch {}
    }
  }
}

const labels = {
  ghostty: 'Ghostty',
  ...Object.fromEntries(Object.entries(SUBJECTS).map(([name, subject]) => [name, subject.label]))
}
const measure = (name) => (name === 'ghostty' ? ghosttySubject() : orcaSubject(name))
const names = options.subjects.split(',')
const rounds = Number(options.rounds)
const samples = Object.fromEntries(names.map((name) => [name, []]))
const ghosttyBefore = names.includes('ghostty') ? ghosttyAccountState() : null
const benchBefore = ghosttyBefore ? ghosttyAccountState(BENCH_GHOSTTY_ID) : null
const benchExistedBefore = ghosttyBefore ? benchDomainExists() : null
for (let round = 0; round < rounds; round += 1) {
  const order = names.map((_, i) => names[(i + round) % names.length])
  for (const name of order) {
    const [sample] = await collectSamples({
      label: `visible ${name} round ${round + 1}`,
      count: 1,
      measure: () => measure(name)
    })
    samples[name].push({ ...sample, index: round })
  }
}

const ghosttyAfter = ghosttyBefore ? ghosttyAccountState() : null
// The account's own Ghostty domain before and after: `changed` names what differs.
const ghosttyAccount = ghosttyBefore && {
  before: ghosttyBefore,
  after: ghosttyAfter,
  changed: Object.keys(ghosttyBefore).filter((key) => JSON.stringify(ghosttyBefore[key]) !== JSON.stringify(ghosttyAfter[key])),
  // The clone's own domain: before the first round, and what its cleanup did after the last.
  bench: { id: BENCH_GHOSTTY_ID, before: benchBefore, ...clearBenchTraces(benchExistedBefore) }
}
if (ghosttyAccount) {
  log(`the account's Ghostty domain: ${ghosttyAccount.changed.length ? `CHANGED (${ghosttyAccount.changed.join(', ')})` : 'unchanged'}`)
  const { bench } = ghosttyAccount
  log(
    `${BENCH_GHOSTTY_ID}: ${bench.existedBefore ? 'existed before the run, left alone' : `${bench.deleted ? 'deleted' : 'never created'}, trashed ${bench.trashed.join(', ') || 'nothing'}`}; ${bench.existsAfterCleanup ? 'STILL there' : 'gone'}`
  )
}
const versions = {
  ghostty: appVersion(GHOSTTY),
  ...Object.fromEntries(
    names.filter((name) => SUBJECTS[name]).map((name) => [name, describeApp(SUBJECTS[name].app)])
  )
}
const windowConditions = `visible focused window ${frame.width}x${frame.height} pt on display ${display.id} (${display.refreshHz} Hz)`
const latencyMetrics = names.map((name) => ({
  id: `latency.${name}`,
  subject: labels[name],
  branch: SUBJECTS[name]?.branch,
  upstream: SUBJECTS[name]?.upstream,
  metric: 'keystroke to pixels on screen',
  unit: 'ms',
  better: 'lower',
  stats: summarize(
    samples[name].flatMap((sample) => sample.perKey),
    'ms'
  ),
  extra: {
    perRoundMedian: summarizeFields(samples[name], { keyToDisplayMs: 'ms' }).keyToDisplayMs,
    misses: samples[name].reduce((sum, sample) => sum + sample.misses, 0)
  },
  conditions: `${windowConditions}, ${options.keys} keys x ${rounds} rounds, zsh line editor echo, cursor blink off`
}))
writeSuiteResult('latency', {
  caveats: [
    `Resolution is one display frame (${(1000 / display.refreshHz).toFixed(1)} ms at ${display.refreshHz} Hz); keys are posted at a random phase.`
  ],
  versions,
  config: { rounds, keys: Number(options.keys), frame, display, preflight },
  ghosttyAccount,
  metrics: latencyMetrics,
  samples
})

if (options.throughput) {
  const metrics = []
  for (const name of names) {
    for (const [workload, definition] of Object.entries(allWorkloads)) {
      const rows = samples[name].map((sample) => sample.throughput[workload])
      const stats = summarizeFields(rows, { totalMs: 'ms', settleMs: 'ms', cpuMs: 'ms' })
      const conditions = `${windowConditions}, grid ${rows[0]?.cols}x${rows[0]?.rows}, cursor blink off`
      metrics.push(
        {
          id: `throughput-visible.${workload}.wall.${name}`,
          subject: labels[name],
          branch: SUBJECTS[name]?.branch,
          upstream: SUBJECTS[name]?.upstream,
          metric: `${definition.label}: wall time (visible window)`,
          unit: 'ms',
          better: 'lower',
          stats: stats.totalMs,
          extra: { settleMs: stats.settleMs },
          conditions
        },
        {
          id: `throughput-visible.${workload}.cpu.${name}`,
          subject: labels[name],
          branch: SUBJECTS[name]?.branch,
          upstream: SUBJECTS[name]?.upstream,
          metric: `${definition.label}: app CPU time (visible window)`,
          unit: 'ms',
          better: 'lower',
          stats: stats.cpuMs,
          conditions
        }
      )
    }
  }
  writeSuiteResult('throughput-visible', {
    versions,
    config: { rounds, frame, display, logFile },
    ghosttyAccount,
    metrics,
    samples: Object.fromEntries(
      names.map((name) => [name, samples[name].map((sample) => sample.throughput)])
    )
  })
}
