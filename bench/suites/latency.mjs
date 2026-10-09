// Visible-window suite: keystroke-to-pixels latency in every app, and (with --throughput) the
// throughput workloads in visible windows, including Ghostty and Terminal.app, which have no
// windowless mode.
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
//        [--subjects orca,pod-native,pod-xterm,ghostty,terminal-app] [--display ID]
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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
  waitForPrompts
} from '../lib/orca-instance.mjs'
import { summarize } from '../lib/sample-stats.mjs'
import { ensureLogFile, measureWorkload, workloads } from '../lib/terminal-workloads.mjs'

const run = promisify(execFile)
const { values: options } = parseArgs({
  options: {
    'confirm-visible': { type: 'boolean', default: false },
    throughput: { type: 'boolean', default: false },
    rounds: { type: 'string', default: '5' },
    keys: { type: 'string', default: '40' },
    subjects: { type: 'string', default: 'orca,pod-native,pod-xterm,ghostty,terminal-app' },
    display: { type: 'string' }
  }
})
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
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app'
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
// from outside, so its throughput window runs this loop instead of an interactive prompt.
function writeRunner(profile, queue) {
  const script = path.join(profile.ud, 'runner.zsh')
  writeFileSync(
    script,
    `while :; do\n  if [[ -f '${queue}' ]]; then c=$(<'${queue}'); rm -f '${queue}'; eval "$c"; fi\n  sleep 0.05\ndone\n`
  )
  return script
}

// Ghostty: a separate instance (open -n) with no user config, Orca's default font size (14).
async function launchGhostty(profile, command) {
  const config = path.join(profile.ud, `ghostty-${Date.now()}.conf`)
  writeFileSync(
    config,
    [
      'font-size = 14',
      'cursor-style-blink = false',
      'window-save-state = never',
      'confirm-close-surface = false',
      'quit-after-last-window-closed = true',
      `window-position-x = ${frame.x}`,
      `window-position-y = ${frame.y}`,
      'window-width = 130',
      'window-height = 40',
      `command = ${command}`
    ].join('\n')
  )
  await run('/usr/bin/open', [
    '-n',
    '-a',
    GHOSTTY,
    '--args',
    '--config-default-files=false',
    `--config-file=${config}`
  ])
  for (let i = 0; i < 100; i += 1) {
    const found = await run('/usr/bin/pgrep', ['-n', '-f', config]).catch(() => null)
    if (found) {
      return Number(found.stdout.trim())
    }
    await sleep(100)
  }
  throw new Error('Ghostty did not start')
}

async function ghosttySubject() {
  const profile = createProfile()
  const env = `/usr/bin/env ZDOTDIR=${profile.zdot} POD_BENCH_PROMPT_LOG=${profile.promptLog}`
  // `clear` first: login(1) may print a "Last login" line above the prompt.
  let pid = await launchGhostty(profile, `/bin/sh -c "clear; exec ${env} /bin/zsh -i"`)
  try {
    await waitForPrompts(profile, 1)
    await keylatJSON(['--activate', String(pid)])
    const bounds = await windowOf(pid)
    await sleep(1_500)
    const rect = regionBelowTitleBar(bounds)
    const latency = { ...(await measureRegion(pid, rect)), rect }
    let throughput = null
    if (options.throughput) {
      process.kill(pid, 'SIGTERM')
      const queue = path.join(profile.ud, 'queue')
      pid = await launchGhostty(profile, `/bin/zsh -f ${writeRunner(profile, queue)}`)
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
      process.kill(pid, 'SIGTERM')
    } catch {}
    await removeProfile(profile)
  }
}

// Terminal.app: one new window running the hermetic zsh, closed afterwards.
async function terminalAppSubject() {
  const profile = createProfile()
  const command = `exec /usr/bin/env ZDOTDIR=${profile.zdot} POD_BENCH_PROMPT_LOG=${profile.promptLog} /bin/zsh -i`
  const doScript = (text) =>
    run('/usr/bin/osascript', [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(text)} in front window`
    ])
  await run('/usr/bin/osascript', [
    '-e',
    `tell application "Terminal"
      do script ${JSON.stringify(command)}
      set bounds of front window to {${frame.x}, ${frame.y}, ${frame.x + frame.width}, ${frame.y + frame.height}}
      activate
    end tell`
  ])
  try {
    await waitForPrompts(profile, 1)
    await doScript('clear')
    const { stdout } = await run('/usr/bin/pgrep', ['-nx', 'Terminal'])
    const pid = Number(stdout.trim())
    const bounds = await windowOf(pid)
    await sleep(1_500)
    const rect = regionBelowTitleBar(bounds)
    const latency = { ...(await measureRegion(pid, rect)), rect, pid }
    const throughput = options.throughput
      ? await runWorkloads(doScript, () => snapshotProcesses(pid), profile.ud)
      : null
    return { ...latency, throughput }
  } finally {
    await run('/usr/bin/osascript', [
      '-e',
      'tell application "Terminal" to close front window saving no'
    ]).catch(() => {})
    await removeProfile(profile)
  }
}

const labels = {
  ghostty: 'Ghostty',
  'terminal-app': 'Terminal.app',
  ...Object.fromEntries(Object.entries(SUBJECTS).map(([name, subject]) => [name, subject.label]))
}
const measure = (name) =>
  name === 'ghostty'
    ? ghosttySubject()
    : name === 'terminal-app'
      ? terminalAppSubject()
      : orcaSubject(name)
const names = options.subjects.split(',')
const rounds = Number(options.rounds)
const samples = Object.fromEntries(names.map((name) => [name, []]))
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

const versions = {
  ghostty: appVersion(GHOSTTY),
  'terminal-app': appVersion(TERMINAL_APP),
  ...Object.fromEntries(
    names.filter((name) => SUBJECTS[name]).map((name) => [name, describeApp(SUBJECTS[name].app)])
  )
}
const windowConditions = `visible focused window ${frame.width}x${frame.height} pt on display ${display.id} (${display.refreshHz} Hz)`
const latencyMetrics = names.map((name) => ({
  id: `latency.${name}`,
  subject: labels[name],
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
  versions,
  config: { rounds, keys: Number(options.keys), frame, display, preflight },
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
    metrics,
    samples: Object.fromEntries(
      names.map((name) => [name, samples[name].map((sample) => sample.throughput)])
    )
  })
}
