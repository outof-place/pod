// node --test bench/lib/orca-instance.test.mjs
// Test dirs stay under PROFILE_BASE (/private/tmp by default); nothing is deleted here. Remove the
// run dir with pod-tmp-rm afterwards.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PROFILE_BASE, cli, describeApp, profilePids } from './orca-instance.mjs'

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

test("profilePids finds a profile's processes in either /tmp spelling, and nothing else", async () => {
  const ud = testDir('pids-')
  assert.ok(ud.startsWith('/private/tmp/'), ud)
  const short = ud.replace(/^\/private\/tmp\//, '/tmp/')
  const children = [
    spawn('/bin/sh', ['-c', 'sleep 30; true', `${ud}/marker`], { stdio: 'ignore' }),
    spawn('/bin/sh', ['-c', 'sleep 30; true', `${short}/marker`], { stdio: 'ignore' }),
    // A sibling dir that only shares the prefix is not the profile.
    spawn('/bin/sh', ['-c', 'sleep 30; true', `${ud}-other/marker`], { stdio: 'ignore' })
  ]
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const found = profilePids(ud)
    assert.ok(found.includes(children[0].pid), 'the /private/tmp spelling')
    assert.ok(found.includes(children[1].pid), 'the /tmp spelling')
    assert.ok(!found.includes(children[2].pid), 'a sibling dir')
    assert.ok(!found.includes(process.pid), 'never this process')
  } finally {
    for (const child of children) {
      child.kill('SIGTERM')
    }
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

test('a one-app bundle is described by its nested runtime, with the outer app recorded', () => {
  const dir = testDir('oneapp-')
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
