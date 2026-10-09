// Startup to an interactive terminal: launch -> the restored workspace's terminal pane prints its
// first shell prompt. Each subject gets one profile whose session holds one focused terminal tab.
//   cold: that profile with Chromium's caches (code cache, GPU/shader caches) deleted first
//   warm: relaunched right after a launch that rebuilt them
// The OS file cache is not purged (that would slow every other process on the machine).
//
//   node bench/suites/startup.mjs [--rounds 7] [--subjects orca,pod-native,pod-xterm]
import { parseArgs } from 'node:util'
import {
  collectSamples,
  log,
  sleep,
  summarizeFields,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import {
  CHROMIUM_CACHE_DIRS,
  SUBJECTS,
  closeInstance,
  createProfile,
  describeApp,
  dropCaches,
  launchInstance,
  openTerminal,
  removeProfile,
  resetPromptLog,
  spawnInstance,
  waitForPrompts,
  waitForRuntime
} from '../lib/orca-instance.mjs'

const { values: options } = parseArgs({
  options: {
    rounds: { type: 'string', default: '7' },
    subjects: { type: 'string', default: 'orca,pod-native,pod-xterm' }
  }
})
const rounds = Number(options.rounds)
const names = options.subjects.split(',')

// Template: a real launch opens the terminal tab and quits cleanly, so the session persists it.
const profiles = {}
for (const name of names) {
  const subject = SUBJECTS[name]
  const profile = createProfile({ experimentalNativeTerminal: subject.nativeTerminal })
  const instance = await launchInstance(subject.app, profile)
  await openTerminal(instance)
  await waitForPrompts(profile, 1)
  await closeInstance(instance, { keepProfile: true })
  profiles[name] = profile
  log(`template ready: ${name}`)
}

async function launchOnce(name, mode) {
  const subject = SUBJECTS[name]
  const profile = profiles[name]
  if (mode === 'cold') {
    dropCaches(profile)
  }
  resetPromptLog(profile)
  const instance = spawnInstance(subject.app, profile)
  try {
    const runtimeAt = await waitForRuntime(instance)
    const [promptAt] = await waitForPrompts(profile, 1)
    // Let the launch finish writing its caches before the next (warm) one.
    await sleep(3_000)
    return {
      runtimeMs: runtimeAt - instance.spawnedAt,
      firstPromptMs: promptAt - instance.spawnedAt
    }
  } finally {
    await closeInstance(instance, { keepProfile: true })
  }
}

const samples = {}
for (const name of names) {
  for (const mode of ['cold', 'warm']) {
    samples[`${name}.${mode}`] = []
  }
} // One warm-up launch per subject, then rounds that rotate the subject order.
for (const name of names) {
  await launchOnce(name, 'warm')
}
for (let round = 0; round < rounds; round += 1) {
  const order = names.map((_, i) => names[(i + round) % names.length])
  for (const name of order) {
    for (const mode of ['cold', 'warm']) {
      const [sample] = await collectSamples({
        label: `startup ${name} ${mode} round ${round + 1}`,
        count: 1,
        measure: () => launchOnce(name, mode)
      })
      samples[`${name}.${mode}`].push({ ...sample, index: round })
    }
  }
}

const metrics = []
const versions = {}
for (const name of names) {
  versions[name] = describeApp(SUBJECTS[name].app)
  for (const mode of ['cold', 'warm']) {
    const stats = summarizeFields(samples[`${name}.${mode}`], {
      firstPromptMs: 'ms',
      runtimeMs: 'ms'
    })
    metrics.push({
      id: `startup.${mode}.${name}`,
      subject: SUBJECTS[name].label,
      branch: SUBJECTS[name].branch,
      upstream: SUBJECTS[name].upstream,
      metric: `startup to first shell prompt (${mode})`,
      unit: 'ms',
      better: 'lower',
      stats: stats.firstPromptMs,
      extra: { runtimeReadyMs: stats.runtimeMs },
      conditions: `windowless launch (ORCA_E2E_HEADLESS), restored workspace with 1 terminal tab, hermetic zsh; ${mode === 'cold' ? `deleted ${CHROMIUM_CACHE_DIRS.join(', ')}` : 'caches from the previous launch'}`
    })
  }
}
for (const profile of Object.values(profiles)) {
  await removeProfile(profile)
}

writeSuiteResult('startup', {
  caveats: [
    'Time to the first shell prompt, from the hermetic zsh prompt log; drawing the prompt is not included. The OS file cache is not purged for cold launches.'
  ],
  versions,
  config: { rounds, subjects: names },
  metrics,
  samples
})
