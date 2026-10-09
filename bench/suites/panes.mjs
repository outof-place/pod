// Memory and idle CPU with 1 and with 8 terminal panes (one tab split into a 4x2 grid), each pane
// at an idle shell prompt. Memory is phys_footprint (Activity Monitor's "Memory") and RSS summed
// over the app's processes: main, renderer, GPU, utility helpers and the terminal daemon; the
// shells themselves are excluded (they are the same in every app).
//
//   node bench/suites/panes.mjs [--rounds 5] [--subjects orca,pod-native,pod-xterm] [--idle-ms 10000]
import { parseArgs } from 'node:util'
import {
  collectSamples,
  log,
  sleep,
  summarizeFields,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import {
  SUBJECTS,
  appUsage,
  cli,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  openTerminal,
  processSnapshot,
  waitForPrompts
} from '../lib/orca-instance.mjs'

const { values: options } = parseArgs({
  options: {
    rounds: { type: 'string', default: '5' },
    subjects: { type: 'string', default: 'orca,pod-native,pod-xterm' },
    'idle-ms': { type: 'string', default: '10000' },
    'settle-ms': { type: 'string', default: '10000' }
  }
})
const rounds = Number(options.rounds)
const names = options.subjects.split(',')
const idleMs = Number(options['idle-ms'])
const settleMs = Number(options['settle-ms'])

async function measurePanes(instance, panes) {
  await sleep(settleMs)
  const before = await processSnapshot(instance)
  await sleep(idleMs)
  const after = await processSnapshot(instance)
  const usage = appUsage(before, after)
  return {
    [`footprintMB${panes}`]: usage.footprintMB,
    [`rssMB${panes}`]: usage.rssMB,
    [`idleCpuMsPerS${panes}`]: (usage.cpuMs / (after.atMs - before.atMs)) * 1000,
    [`byRole${panes}`]: Object.fromEntries(
      Object.entries(usage.byRole).map(([role, value]) => [
        role,
        {
          footprintMB: Number(value.footprintMB.toFixed(1)),
          cpuMsPerS: Number(((value.cpuMs / (after.atMs - before.atMs)) * 1000).toFixed(2)),
          count: value.count
        }
      ])
    )
  }
}

// 1 -> 8 panes: split the first pane, then every pane, then every pane again.
async function splitToEight(instance, handle) {
  let handles = [handle]
  for (const direction of ['vertical', 'horizontal', 'vertical']) {
    const next = []
    for (const current of handles) {
      const created = await cli(instance, [
        'terminal',
        'split',
        '--terminal',
        current,
        '--direction',
        direction
      ])
      next.push(current, created.split.handle)
    }
    handles = next
  }
  return handles
}

const samples = Object.fromEntries(names.map((name) => [name, []]))
for (let round = 0; round < rounds; round += 1) {
  const order = names.map((_, i) => names[(i + round) % names.length])
  for (const name of order) {
    const subject = SUBJECTS[name]
    const [sample] = await collectSamples({
      label: `panes ${name} round ${round + 1}`,
      count: 1,
      measure: async () => {
        const profile = createProfile({ experimentalNativeTerminal: subject.nativeTerminal })
        const instance = await launchInstance(subject.app, profile)
        try {
          const handle = await openTerminal(instance)
          await waitForPrompts(profile, 1)
          const one = await measurePanes(instance, 1)
          const handles = await splitToEight(instance, handle)
          await waitForPrompts(profile, 8)
          const eight = await measurePanes(instance, 8)
          return { ...one, ...eight, panes: handles.length }
        } finally {
          await closeInstance(instance)
        }
      }
    })
    samples[name].push({ ...sample, index: round })
  }
}

const metrics = []
const versions = {}
for (const name of names) {
  versions[name] = describeApp(SUBJECTS[name].app)
  const stats = summarizeFields(samples[name], {
    footprintMB1: 'MiB',
    rssMB1: 'MiB',
    idleCpuMsPerS1: 'ms/s',
    footprintMB8: 'MiB',
    rssMB8: 'MiB',
    idleCpuMsPerS8: 'ms/s'
  })
  for (const panes of [1, 8]) {
    const conditions = `windowless instance, background throttling off, ${panes} pane(s) at an idle prompt, default settings (cursor blink on), ${settleMs / 1000} s settle, ${idleMs / 1000} s window`
    metrics.push(
      {
        id: `memory.${panes}.${name}`,
        subject: SUBJECTS[name].label,
        branch: SUBJECTS[name].branch,
        upstream: SUBJECTS[name].upstream,
        metric: `memory (phys_footprint), ${panes} pane${panes > 1 ? 's' : ''}`,
        unit: 'MiB',
        better: 'lower',
        stats: stats[`footprintMB${panes}`],
        extra: { rssMB: stats[`rssMB${panes}`] },
        conditions
      },
      {
        id: `idle-cpu.${panes}.${name}`,
        subject: SUBJECTS[name].label,
        branch: SUBJECTS[name].branch,
        upstream: SUBJECTS[name].upstream,
        metric: `idle CPU, ${panes} pane${panes > 1 ? 's' : ''}`,
        unit: 'ms CPU per s',
        better: 'lower',
        stats: stats[`idleCpuMsPerS${panes}`],
        conditions
      }
    )
  }
}
log('done')
writeSuiteResult('panes', {
  caveats: [
    'Windowless instances with background throttling off; memory includes the GPU process, and a native view in a window that is never on screen may not draw.'
  ],
  versions,
  config: { rounds, subjects: names, idleMs, settleMs },
  metrics,
  samples
})
