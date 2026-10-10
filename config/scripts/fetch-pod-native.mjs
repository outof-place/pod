#!/usr/bin/env node
// Puts the PodNative.app pinned in config/pod-native.json where the Pod macOS build takes it from
// (config/pod-native-extra-files.cjs nests it as Contents/Helpers/PodNative.app). The pin names a
// release asset of outof-place/pod-native made by its scripts/release-app.sh: Developer ID signed,
// hardened runtime, notarized. The app is unpacked in ~/Library/Caches, outside the worktree, so
// nothing reaches app.asar and neither Spotlight nor LaunchServices registers it.
//
//   node config/scripts/fetch-pod-native.mjs           download the pinned zip (gh), verify, unpack
//   node config/scripts/fetch-pod-native.mjs --check   verify the unpacked app only; never downloads
//
// A local PodNative build skips this: POD_NATIVE_APP_SOURCE=<PodNative.app> (still verified).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import podNative from '../pod-native-extra-files.cjs'

const { readPodNativePin, podNativeAppSource } = podNative
export const POD_NATIVE_BUNDLE_ID = 'codes.pod.native'

function run(program, args) {
  const done = spawnSync(program, args, { encoding: 'utf8' })
  return { status: done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}` }
}

function plistValue(app, key) {
  const done = run('/usr/bin/plutil', ['-extract', key, 'raw', join(app, 'Contents', 'Info.plist')])
  return done.status === 0 ? done.out.trim() : null
}

/**
 * What Pod may nest: PodNative at the pinned revision, Developer ID signed by the release team
 * with the hardened runtime and a secure timestamp, no debugging entitlement, seal intact.
 */
export function assertPodNativeApp(app, pin, exec = run, plist = plistValue) {
  if (plist(app, 'CFBundleIdentifier') !== POD_NATIVE_BUNDLE_ID) {
    throw new Error(`${app} is not ${POD_NATIVE_BUNDLE_ID}`)
  }
  const revision = plist(app, 'PodNativeRevision')
  if (revision !== pin.revision) {
    throw new Error(`${app} is revision ${revision}, the pin says ${pin.revision}`)
  }
  const verify = exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  if (verify.status !== 0) {
    throw new Error(`codesign --verify ${app}: ${verify.out.trim()}`)
  }
  const details = exec('/usr/bin/codesign', ['-dvv', app]).out
  for (const line of [
    `TeamIdentifier=${pin.teamId}`,
    'Authority=Developer ID Application:',
    'flags=0x10000(runtime)',
    'Timestamp='
  ]) {
    if (!details.includes(line)) {
      throw new Error(`${app}: codesign -dvv lacks ${line}`)
    }
  }
  const entitlements = exec('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]).out
  if (entitlements.includes('get-task-allow')) {
    throw new Error(`${app} carries get-task-allow`)
  }
  return app
}

function download(pin, into) {
  const work = mkdtempSync(join(dirname(into), '.fetch-'))
  try {
    const got = run('gh', [
      'release',
      'download',
      pin.tag,
      '--repo',
      pin.repository,
      '--pattern',
      pin.asset,
      '--dir',
      work
    ])
    if (got.status !== 0) {
      throw new Error(`gh release download ${pin.tag} (${pin.repository}): ${got.out.trim()}`)
    }
    const zip = join(work, pin.asset)
    const digest = createHash('sha256').update(readFileSync(zip)).digest('hex')
    if (digest !== pin.sha256) {
      throw new Error(`${pin.asset} is sha256 ${digest}, the pin says ${pin.sha256}`)
    }
    const unzip = run('/usr/bin/ditto', ['-x', '-k', zip, work])
    if (unzip.status !== 0) {
      throw new Error(`ditto -x ${zip}: ${unzip.out.trim()}`)
    }
    const app = assertPodNativeApp(join(work, 'PodNative.app'), pin)
    // Why rename: a reader never sees a half-unpacked app at the pinned path.
    renameSync(app, into)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Why realpath: run through a symlinked path (/tmp), a plain compare skips main() and exits 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const pin = readPodNativePin()
  const app = podNativeAppSource({ pin })
  if (!process.env.POD_NATIVE_APP_SOURCE && !existsSync(app) && !process.argv.includes('--check')) {
    mkdirSync(dirname(app), { recursive: true })
    download(pin, app)
  }
  if (!existsSync(app)) {
    throw new Error(`no PodNative.app at ${app}: run node config/scripts/fetch-pod-native.mjs`)
  }
  assertPodNativeApp(app, pin)
  console.log(`PodNative ${pin.tag} (${pin.revision}) at ${app}`)
}
