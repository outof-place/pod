// node --test bench/lib/acc-guard.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ACC_OFF_ENV,
  TRIP_EXIT_CODE,
  accState,
  accStateChanges,
  assertAccOff,
  setupProcesses
} from './acc-guard.mjs'
import { launchEnv } from './orca-instance.mjs'

const GUARD = fileURLToPath(new URL('./acc-guard.mjs', import.meta.url))
const LABEL = 'com.filip.claude-acc.janitor'

function printOf(home, label) {
  return `gui/501/${label} = {\n\tactive count = 0\n\tpath = ${home}/Library/LaunchAgents/${label}.plist\n\tprogram = ${home}/.local/share/claude-acc/python\n\targuments = {\n\t\t${home}/.local/share/claude-acc/python\n\t\t${home}/.local/share/claude-acc/janitor.py\n\t}\n}\n`
}

// A home with one claude-acc plist and owner.json, plus a launchctl that serves files from it.
function fakeInstall() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'acc-guard-test-'))
  mkdirSync(path.join(home, 'Library/LaunchAgents'), { recursive: true })
  mkdirSync(path.join(home, '.local/share/claude-acc'), { recursive: true })
  mkdirSync(path.join(home, 'launchctl'))
  writeFileSync(path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`), '<plist/>')
  writeFileSync(path.join(home, 'Library/LaunchAgents/com.example.other.plist'), '<plist/>')
  writeFileSync(path.join(home, '.local/share/claude-acc/owner.json'), '{"owner":"pod"}\n')
  const jobs = { [LABEL]: printOf(home, LABEL) }
  const writeJobs = () => {
    const list = Object.keys(jobs)
      .map((label) => `-\t0\t${label}`)
      .join('\n')
    writeFileSync(
      path.join(home, 'launchctl/list'),
      `PID\tStatus\tLabel\n${list}\n-\t0\tapplication.com.filip.claude-acc.menubar.1.2\n`
    )
    for (const [label, text] of Object.entries(jobs)) {
      writeFileSync(path.join(home, 'launchctl', label), text)
    }
  }
  writeJobs()
  const script = path.join(home, 'launchctl/fake-launchctl')
  writeFileSync(
    script,
    `#!/bin/sh\nd="${home}/launchctl"\nif [ "$1" = list ]; then cat "$d/list"; else cat "$d/\${2##*/}"; fi\n`
  )
  chmodSync(script, 0o755)
  const launchctl = (args) => spawnSync(script, args, { encoding: 'utf8' }).stdout
  return {
    home,
    jobs,
    writeJobs,
    script,
    launchctl,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  }
}

test('launches refuse to start unless POD_ACC_LIFECYCLE is exactly off', () => {
  assert.throws(() => assertAccOff({}), /POD_ACC_LIFECYCLE=off/)
  assert.throws(() => assertAccOff({ POD_ACC_LIFECYCLE: 'OFF' }), /POD_ACC_LIFECYCLE=off/)
  assert.throws(() => assertAccOff({ POD_ACC_LIFECYCLE: 'dry-run' }), /POD_ACC_LIFECYCLE=off/)
  assert.doesNotThrow(() => assertAccOff({ POD_ACC_LIFECYCLE: 'off' }))
  assert.equal(ACC_OFF_ENV.POD_ACC_LIFECYCLE, 'off')
})

test('every app launch env carries POD_ACC_LIFECYCLE=off, headless and visible', () => {
  const profile = { home: '/h', ud: '/h/ud', zdot: '/h/z', promptLog: '/h/p' }
  for (const visible of [false, true]) {
    const env = launchEnv(profile, { visible })
    assert.equal(env.POD_ACC_LIFECYCLE, 'off')
    assert.doesNotThrow(() => assertAccOff(env))
  }
})

test('an unchanged install reports no changes; only claude-acc entries are tracked', () => {
  const fake = fakeInstall()
  try {
    const state = accState({ home: fake.home, uid: 501, launchctl: fake.launchctl })
    assert.deepEqual(Object.keys(state.plists), [`${LABEL}.plist`])
    assert.deepEqual(Object.keys(state.jobs), [LABEL])
    assert.equal(state.jobs[LABEL].path, `${fake.home}/Library/LaunchAgents/${LABEL}.plist`)
    assert.match(state.jobs[LABEL].arguments, /janitor\.py/)
    const again = accState({ home: fake.home, uid: 501, launchctl: fake.launchctl })
    assert.deepEqual(accStateChanges(state, again), [])
  } finally {
    fake.cleanup()
  }
})

test('rewritten plists, a new owner.json and re-pointed or unloaded jobs are all changes', () => {
  const fake = fakeInstall()
  const read = () => accState({ home: fake.home, uid: 501, launchctl: fake.launchctl })
  try {
    const before = read()
    const plist = path.join(fake.home, 'Library/LaunchAgents', `${LABEL}.plist`)
    utimesSync(plist, new Date(), new Date(Date.now() + 5_000))
    assert.deepEqual(accStateChanges(before, read()), [`${LABEL}.plist was rewritten`])

    const base = read()
    writeFileSync(path.join(fake.home, '.local/share/claude-acc/owner.json'), '{"owner":"x"}\n')
    assert.deepEqual(accStateChanges(base, read()), ['claude-acc owner.json changed'])

    // setup.sh under a temporary HOME: the real plist keeps its mtime, the loaded job moves.
    const loaded = read()
    fake.jobs[LABEL] = printOf('/var/folders/tmp-home', LABEL)
    fake.writeJobs()
    const moved = accStateChanges(loaded, read())
    assert.equal(moved.length, 3)
    assert.match(moved[0], /path changed from .* to \/var\/folders\/tmp-home/)

    const beforeUnload = read()
    delete fake.jobs[LABEL]
    fake.writeJobs()
    assert.deepEqual(accStateChanges(beforeUnload, read()), [`launchd job ${LABEL} was unloaded`])
  } finally {
    fake.cleanup()
  }
})

test('setup.sh rows are found and attributed to the bench instance that started them', () => {
  const ps = [
    '  1     0 /sbin/launchd',
    ' 100     1 /x/Pod.app/Contents/MacOS/Pod --password-store=basic',
    ' 101   100 /x/Pod.app/Contents/Frameworks/Pod Helper.app/Contents/MacOS/Pod Helper',
    ' 102   101 /bin/bash /x/Pod.app/Contents/Resources/claude-acc/setup.sh --owner pod',
    ' 200     1 /bin/bash /Applications/Pod.app/Contents/Resources/claude-acc/setup.sh --owner pod',
    ' 300     1 /bin/sh ./scripts/setup.sh',
    ' 301     1 /usr/bin/grep claude-acc'
  ].join('\n')
  const found = setupProcesses(ps, [100])
  assert.deepEqual(
    found.map(({ pid, ours }) => ({ pid, ours })),
    [
      { pid: 102, ours: true },
      { pid: 200, ours: false }
    ]
  )
})

function runGuard(args, env) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

test('--check exits 70 and records why when the install changed after --baseline', () => {
  const fake = fakeInstall()
  const out = mkdtempSync(path.join(os.tmpdir(), 'acc-guard-out-'))
  try {
    const env = { HOME: fake.home, POD_BENCH_LAUNCHCTL: fake.script, POD_BENCH_OUT: out }
    const file = path.join(out, 'acc-baseline.raw')
    assert.equal(runGuard(['--baseline', file], env).status, 0)
    assert.equal(runGuard(['--check', file], env).status, 0)
    writeFileSync(path.join(fake.home, '.local/share/claude-acc/owner.json'), '{"owner":"tmp"}\n')
    const tripped = runGuard(['--check', file], env)
    assert.equal(tripped.status, TRIP_EXIT_CODE)
    assert.match(tripped.stderr, /claude-acc guard tripped between suites/)
    const record = JSON.parse(readFileSync(path.join(out, 'acc-guard-tripped.raw'), 'utf8'))
    assert.deepEqual(record.problems, ['claude-acc owner.json changed'])
  } finally {
    fake.cleanup()
    rmSync(out, { recursive: true, force: true })
  }
})

test('a claude-acc setup.sh appearing while an instance runs stops the process at once', async () => {
  const fake = fakeInstall()
  const dir = path.join(fake.home, 'payload/claude-acc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'setup.sh'), 'sleep 30\n')
  const out = mkdtempSync(path.join(os.tmpdir(), 'acc-guard-out-'))
  // Stands in for a bench instance: the guard watches while it is registered.
  const instance = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  const killed = path.join(out, 'killed')
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { guardInstance } from ${JSON.stringify(GUARD)}
       import { writeFileSync } from 'node:fs'
       guardInstance(${instance.pid}, () => writeFileSync(${JSON.stringify(killed)}, 'yes'))
       setTimeout(() => process.exit(0), 15000)`
    ],
    {
      env: {
        ...process.env,
        HOME: fake.home,
        POD_BENCH_LAUNCHCTL: fake.script,
        POD_BENCH_OUT: out
      },
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  // Its own process group, so the sleep it starts dies with it.
  const setup = spawn('/bin/sh', [path.join(dir, 'setup.sh')], { stdio: 'ignore', detached: true })
  try {
    const code = await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(code, TRIP_EXIT_CODE)
    assert.match(stderr, /setup\.sh pid \d+ \(not under a bench instance\)/)
    assert.ok(existsSync(killed), 'the guard stops its instances before exiting')
  } finally {
    process.kill(-setup.pid, 'SIGKILL')
    instance.kill('SIGKILL')
    child.kill('SIGKILL')
    fake.cleanup()
    rmSync(out, { recursive: true, force: true })
  }
})
