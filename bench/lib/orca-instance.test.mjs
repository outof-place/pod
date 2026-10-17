// node --test bench/lib/orca-instance.test.mjs
// Test dirs stay under PROFILE_BASE. Without POD_BENCH_PROFILE_BASE that is this process's own
// /private/tmp/pod-bench.<pid>.* dir, which goes through pod-tmp-rm (where installed) at the end.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { ENV_CANARY, GUARD_PATH_REVISION, callerCanary } from './guard-path.mjs'
import {
  PROFILE_BASE,
  cli,
  describeApp,
  ensureGuard,
  killRoot,
  launchEnv,
  launchInstance,
  profileIn,
  removeProfile,
  writePromptHook
} from './orca-instance.mjs'
import { rootOfPid } from './run-tree.mjs'

after(() => {
  const remover = path.join(os.homedir(), '.local/bin/pod-tmp-rm')
  const own = path.dirname(PROFILE_BASE)
  if (!process.env.POD_BENCH_PROFILE_BASE && own.startsWith(`/private/tmp/pod-bench.${process.pid}.`) && existsSync(own) && existsSync(remover)) {
    execFileSync(remover, [own], { stdio: 'ignore' })
  }
})

function testDir(prefix) {
  mkdirSync(PROFILE_BASE, { recursive: true })
  return mkdtempSync(path.join(PROFILE_BASE, prefix))
}

// Stands in for orca/podx. `status` reports the runtime id in $FAKE_RUNTIME_ID's file; any other
// call echoes the environment it was given. Every call is logged.
function fakeCli(ud, runtimeId) {
  const fake = path.join(ud, 'fake-cli')
  writeFileSync(path.join(ud, 'reached-runtime'), runtimeId)
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$1" >> '${path.join(ud, 'calls.log')}'
if [ "$1" = status ]; then
  printf '{"ok":true,"result":{"runtime":{"runtimeId":"%s"}}}' "$(cat '${path.join(ud, 'reached-runtime')}')"
  exit 0
fi
printf '{"ok":true,"result":{"orca":"%s","pod":"%s","acc":"%s","home":"%s"}}' "$ORCA_USER_DATA_PATH" "$POD_USER_DATA_PATH" "$POD_ACC_LIFECYCLE" "$HOME"
`
  )
  chmodSync(fake, 0o755)
  return fake
}

function instanceWithRuntime(ud, fake) {
  writeFileSync(path.join(ud, 'orca-runtime.json'), JSON.stringify({ runtimeId: 'bench-runtime' }))
  return { info: { cli: fake }, profile: { ud, home: path.join(ud, 'home') } }
}

test("the app CLI gets the profile under Orca's and Pod's names, and POD_ACC_LIFECYCLE=off", async () => {
  const ud = testDir('cli-test-')
  const instance = instanceWithRuntime(ud, fakeCli(ud, 'bench-runtime'))
  assert.deepEqual(await cli(instance, ['repo', 'list']), {
    orca: ud,
    pod: ud,
    acc: 'off',
    home: instance.profile.home
  })
  // The target is checked once, before the first call.
  assert.deepEqual(readFileSync(path.join(ud, 'calls.log'), 'utf8').split('\n').filter(Boolean), [
    'status',
    'repo'
  ])
})

test('a CLI that reaches another runtime is stopped before any change', async () => {
  const ud = testDir('cli-target-')
  const instance = instanceWithRuntime(ud, fakeCli(ud, 'the-users-live-pod'))
  await assert.rejects(cli(instance, ['repo', 'add', '--path', ud]), /stopping before any change/)
  await assert.rejects(cli(instance, ['terminal', 'create']), /stopping before any change/)
  assert.deepEqual(readFileSync(path.join(ud, 'calls.log'), 'utf8').split('\n').filter(Boolean), [
    'status'
  ])
})

test("a profile's cleanup stops its own processes and leaves a stranger that names it alone", async () => {
  const ud = testDir('pids-')
  assert.ok(ud.startsWith('/private/tmp/'), ud)
  const short = ud.replace(/^\/private\/tmp\//, '/tmp/')
  // An app copy the run launched from: a process of it naming the profile is the run's (crashpad).
  const app = path.join(testDir('app-'), 'App.app')
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(path.join(ud, 'tool.c'), '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n')
  execFileSync('xcrun', ['clang', '-O2', '-o', path.join(app, 'Contents/MacOS/crashpad'), path.join(ud, 'tool.c')])
  const own = spawn('/bin/sh', ['-c', 'sleep 30; true'], { stdio: 'ignore' })
  const crashpad = spawn(path.join(app, 'Contents/MacOS/crashpad'), [`--database=${ud}/Crashpad`], { stdio: 'ignore' })
  const strangers = [
    spawn('/bin/sh', ['-c', 'sleep 30; true', `${ud}/marker`], { stdio: 'ignore' }),
    spawn('/bin/sh', ['-c', 'sleep 30; true', `${short}/marker`], { stdio: 'ignore' })
  ]
  // A recorded root whose pid a later process took (another start time) is not the run's.
  const reused = spawn('/bin/sh', ['-c', 'sleep 30; true'], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const stale = { ...rootOfPid(reused.pid), startUs: rootOfPid(reused.pid).startUs - 1 }
  const profile = {
    ud,
    roots: new Map([
      [own.pid, rootOfPid(own.pid)],
      [reused.pid, stale]
    ]),
    apps: new Set([app]),
    signalled: [],
    argvOnly: []
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await removeProfile(profile)
    const signalled = new Set(profile.signalled.map((entry) => entry.pid))
    assert.ok(signalled.has(own.pid), 'the run spawned it')
    assert.ok(signalled.has(crashpad.pid), 'its executable is the run app, and it names the profile')
    for (const stranger of strangers) {
      assert.ok(!signalled.has(stranger.pid), 'a stranger is never signalled')
      assert.ok(profile.argvOnly.some((entry) => entry.pid === stranger.pid), 'but it is reported')
      process.kill(stranger.pid, 0)
    }
    assert.ok(!signalled.has(reused.pid), 'a pid whose start time is not the recorded one')
    process.kill(reused.pid, 0)
    assert.ok(!signalled.has(process.pid), 'never this process')
  } finally {
    for (const child of [own, crashpad, reused, ...strangers]) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
  }
})

test("the claude-acc guard's kill of the app's own pid needs the start time recorded at launch", async () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const root = rootOfPid(child.pid)
    assert.deepEqual(killRoot({ roots: new Map([[child.pid, { ...root, startUs: root.startUs - 1 }]]) }, child.pid), [])
    assert.deepEqual(killRoot({ roots: new Map() }, child.pid), [], 'not a recorded root')
    process.kill(child.pid, 0)
    assert.equal(killRoot({ roots: new Map([[child.pid, root]]) }, child.pid).length, 1)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

function plist(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true })
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('')
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`
  )
}

function fakeOneApp(dir) {
  const outer = path.join(dir, 'Pod.app')
  const runtime = path.join(outer, 'Contents/Helpers/Pod Runtime.app')
  plist(path.join(outer, 'Contents/Info.plist'), {
    CFBundleIdentifier: 'codes.pod.native',
    CFBundleExecutable: 'PodNative',
    CFBundleShortVersionString: '1.0.0-rc1',
    CFBundleVersion: '1000001',
    PodNativeRevision: 'abc123'
  })
  plist(path.join(runtime, 'Contents/Info.plist'), {
    CFBundleIdentifier: 'codes.pod.app',
    CFBundleExecutable: 'Pod',
    CFBundleShortVersionString: '1.0.0-rc1'
  })
  mkdirSync(path.join(runtime, 'Contents/Resources/bin'), { recursive: true })
  writeFileSync(
    path.join(runtime, 'Contents/Resources/orca-local-build.json'),
    JSON.stringify({ commit: 'b9b9850092d3', buildId: '1.0.0-rc1-b9b9850092d3-arm64' })
  )
  writeFileSync(path.join(runtime, 'Contents/Resources/bin/podx'), '')
  return { outer, runtime }
}

test('a one-app bundle is described by its nested runtime, with the outer app recorded', () => {
  const { outer, runtime } = fakeOneApp(testDir('oneapp-'))
  const info = describeApp(outer)
  assert.equal(info.bundleId, 'codes.pod.app')
  assert.ok(info.executable.endsWith('/Pod Runtime.app/Contents/MacOS/Pod'), info.executable)
  assert.ok(info.cli.endsWith('/Pod Runtime.app/Contents/Resources/bin/podx'), info.cli)
  assert.equal(info.commit, 'b9b9850092d3')
  assert.deepEqual(info.oneApp, {
    bundleId: 'codes.pod.native',
    version: '1.0.0-rc1',
    build: '1000001',
    podNativeRevision: 'abc123'
  })
  // Naming the nested runtime directly gives the same record.
  assert.equal(describeApp(runtime).oneApp.bundleId, 'codes.pod.native')
  assert.ok(existsSync(info.realPath))
})

test('a visible launch of a one-app runtime is refused before anything starts', async () => {
  const dir = testDir('oneapp-visible-')
  const { outer } = fakeOneApp(dir)
  const profile = { ud: dir, home: path.join(dir, 'home') }
  await assert.rejects(
    launchInstance(outer, profile, { visible: true }),
    /refusing a visible launch of a one-app runtime/
  )
})

const PODNATIVE_REPO = path.join(os.homedir(), 'Documents/orca-native-wt/native-ui/PodNative')
const haveHelper = (() => {
  try {
    execFileSync('git', ['-C', PODNATIVE_REPO, 'cat-file', '-e', `${GUARD_PATH_REVISION}:scripts/guard-path.sh`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test(
  "a launch's words for guard_exec: the guard PATH, a short TMPDIR, never the caller's canary",
  { skip: !haveHelper && `PodNative ${GUARD_PATH_REVISION} not in ${PODNATIVE_REPO}` },
  () => {
    const profile = profileIn(testDir('p'))
    assert.throws(() => launchEnv(profile), /no guard PATH yet/)
    // No catalog (no tree): this test reads no app.
    ensureGuard(profile, { realPath: undefined })
    const zshrc = readFileSync(path.join(profile.zdot, '.zshrc'), 'utf8')
    assert.ok(zshrc.startsWith('# guard-path.sh:'), 'the guard wrote ZDOTDIR\'s .zshrc first')
    assert.ok(zshrc.includes('precmd()'), 'and the prompt-time hook went in after it')
    assert.throws(() => writePromptHook(profile), /the guard owns/)
    const canary = callerCanary()
    const env = launchEnv(profile)
    assert.ok(!Object.values(env).some((value) => value.includes(canary)), `no ${ENV_CANARY}`)
    assert.equal(env.HOME, profile.home)
    assert.ok(env.PATH.split(':').includes(`${profile.ud}/guard-bin`), env.PATH)
    assert.ok(env.TMPDIR.startsWith(`${path.dirname(PROFILE_BASE)}/t/`), env.TMPDIR)
    assert.ok(Buffer.byteLength(env.TMPDIR) <= 48, env.TMPDIR)
    assert.deepEqual(profile.guard.fronts, [], 'no front dir outside the run dir')
    for (const name of ['USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'DISPLAY', 'TERM', 'NODE_OPTIONS', 'TMUX']) {
      assert.equal(env[name], undefined, name)
    }
  }
)

test('a profile for a zsh outside an app gets the prompt-time hook as its whole .zshrc', () => {
  const profile = profileIn(testDir('p'))
  writePromptHook(profile)
  assert.ok(readFileSync(path.join(profile.zdot, '.zshrc'), 'utf8').startsWith('zmodload zsh/datetime'))
  assert.throws(() => ensureGuard(profile, { realPath: undefined }), /needs a ZDOTDIR the guard can own/)
})
