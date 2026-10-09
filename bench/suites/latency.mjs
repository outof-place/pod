// Keystroke-to-pixels latency, measured the same way in every app by keylat: a CGEvent key posted
// to the app's pid, and the display time of the first ScreenCaptureKit frame (at the display's
// refresh rate) in which the echoed glyph changed the pixels of a small region at the prompt.
// The shell is the same hermetic zsh everywhere; cursor blink is off everywhere.
//
// This needs visible, focused windows, so it takes the desktop: run it only in a slot the user
// agreed to. Without --confirm-visible it only checks permissions and the detector (dry run).
//
//   node bench/suites/latency.mjs [--confirm-visible] [--rounds 5] [--keys 40]
//        [--subjects orca,pod-native,pod-xterm,ghostty,terminal-app] [--display ID]
import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  TOOLS_BIN,
  collectSamples,
  log,
  sleep,
  summarizeFields,
  writeSuiteResult,
  appVersion
} from '../lib/bench-session.mjs'
import {
  SUBJECTS,
  cli,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  openTerminal,
  removeProfile,
  waitForPrompts
} from '../lib/orca-instance.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const run = promisify(execFile)
const { values: options } = parseArgs({
  options: {
    'confirm-visible': { type: 'boolean', default: false },
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
const PROMPT_REGION = { width: 360, height: 48 }

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
    await cli(instance, ['terminal', 'send', '--terminal', handle, '--text', 'clear', '--enter'])
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
    return { ...(await measureRegion(instance.pid, rect)), rect }
  } finally {
    await closeInstance(instance)
  }
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

// Ghostty: a separate instance with no user config, the same font size as Orca's default (14).
async function ghosttySubject() {
  const profile = createProfile()
  const config = path.join(profile.ud, 'ghostty.conf')
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
      `command = /usr/bin/env ZDOTDIR=${profile.zdot} POD_BENCH_PROMPT_LOG=${profile.promptLog} /bin/zsh -i`
    ].join('\n')
  )
  const child = spawn(
    `${GHOSTTY}/Contents/MacOS/ghostty`,
    ['--config-default-files=false', `--config-file=${config}`],
    { stdio: 'ignore' }
  )
  try {
    await waitForPrompts(profile, 1)
    await keylatJSON(['--activate', String(child.pid)])
    const bounds = await windowOf(child.pid)
    await sleep(1_500)
    const rect = [
      bounds[0] - display.bounds[0] + 4,
      bounds[1] - display.bounds[1] + 30,
      PROMPT_REGION.width,
      PROMPT_REGION.height
    ]
    return { ...(await measureRegion(child.pid, rect)), rect }
  } finally {
    child.kill('SIGTERM')
    await removeProfile(profile)
  }
}

// Terminal.app: one new window running the hermetic zsh, closed afterwards.
async function terminalAppSubject() {
  const profile = createProfile()
  const command = `exec /usr/bin/env ZDOTDIR=${profile.zdot} POD_BENCH_PROMPT_LOG=${profile.promptLog} /bin/zsh -i`
  const script = `tell application "Terminal"
    set w to do script "${command}"
    set bounds of front window to {${frame.x}, ${frame.y}, ${frame.x + frame.width}, ${frame.y + frame.height}}
    activate
  end tell`
  await run('/usr/bin/osascript', ['-e', script])
  try {
    await waitForPrompts(profile, 1)
    const { stdout } = await run('/usr/bin/pgrep', ['-nx', 'Terminal'])
    const pid = Number(stdout.trim())
    const bounds = await windowOf(pid)
    await sleep(1_500)
    const rect = [
      bounds[0] - display.bounds[0] + 4,
      bounds[1] - display.bounds[1] + 30,
      PROMPT_REGION.width,
      PROMPT_REGION.height
    ]
    return { ...(await measureRegion(pid, rect)), rect, pid }
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
      label: `latency ${name} round ${round + 1}`,
      count: 1,
      measure: () => measure(name)
    })
    samples[name].push({ ...sample, index: round })
  }
}

const versions = {
  ghostty: appVersion(GHOSTTY),
  'terminal-app': appVersion('/System/Applications/Utilities/Terminal.app'),
  ...Object.fromEntries(
    names.filter((name) => SUBJECTS[name]).map((name) => [name, describeApp(SUBJECTS[name].app)])
  )
}
const metrics = names.map((name) => ({
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
  conditions: `visible focused window ${frame.width}x${frame.height} pt on display ${display.id} (${display.refreshHz} Hz), ${options.keys} keys x ${rounds} rounds, zsh line editor echo, cursor blink off`
}))
writeSuiteResult('latency', {
  versions,
  config: { rounds, keys: Number(options.keys), frame, display, preflight },
  metrics,
  samples
})
