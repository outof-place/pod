#!/usr/bin/env node
// Puts PodNative (Pod's native UI, the private outof-place/pod-native) into
// resources/pod-native/PodNative.app; the Pod macOS build ships it as Contents/Helpers/PodNative.app
// (product/pod-native-embed.cjs). The pin in config/pod-native.json names the release asset: a zip
// of the unsigned app, which Pod's release signs. gh downloads it, since the repository is private.
//
//   node config/scripts/fetch-pod-native.mjs            download the pinned zip, verify, unpack
//   node config/scripts/fetch-pod-native.mjs --from X   X = a PodNative.app or a zip of one (local
//                                                       builds; checked against the pin only when X
//                                                       is the pinned asset)
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
export const POD_NATIVE_DIR = join(ROOT, 'resources', 'pod-native')
const PIN = join(ROOT, 'config', 'pod-native.json')
const APP = 'PodNative.app'
const STAMP = '.source.json'
const SHA256 = /^[0-9a-f]{64}$/

export function readPin(path = PIN) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Only a download needs the whole pin; --from works before the first PodNative release. */
function assertDownloadPin(pin) {
  for (const key of ['repository', 'tag', 'asset']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(
        `config/pod-native.json has no ${key} yet: pin a released PodNative, or use --from <PodNative.app>`
      )
    }
  }
  if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) {
    throw new Error(
      'config/pod-native.json has no sha256 yet: pin a released PodNative, or use --from <PodNative.app>'
    )
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertApp(app) {
  if (!existsSync(join(app, 'Contents', 'Info.plist'))) {
    throw new Error(`${app} is not an app bundle`)
  }
}

/** Copies `app` to <into>/PodNative.app through a sibling folder, so a failed run keeps the old copy. */
function install(app, into, stamp) {
  assertApp(app)
  const next = `${into}.next`
  rmSync(next, { recursive: true, force: true })
  mkdirSync(next, { recursive: true })
  execFileSync('/usr/bin/ditto', [app, join(next, APP)])
  // Why: a browser download's quarantine would follow the app into Pod.app (an APFS clone keeps it).
  execFileSync('/usr/bin/xattr', ['-cr', join(next, APP)])
  writeFileSync(join(next, STAMP), `${JSON.stringify(stamp)}\n`)
  rmSync(into, { recursive: true, force: true })
  renameSync(next, into)
}

function unpack(zip, into, stamp) {
  const work = mkdtempSync(join(tmpdir(), 'pod-native-unpack-'))
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', '--noqtn', zip, work])
    install(join(work, APP), into, stamp)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The release asset, through gh: the repository is private, so a plain download gets a 404. */
function ghDownload(pin, dir) {
  execFileSync(
    'gh',
    [
      'release',
      'download',
      pin.tag,
      '--repo',
      pin.repository,
      '--pattern',
      pin.asset,
      '--dir',
      dir
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  return join(dir, pin.asset)
}

/** @param {{ from?: string | null, into?: string, pin?: { repository: string, tag: string, asset: string, sha256: string | null }, download?: typeof ghDownload }} [options] */
export function fetchPodNative({
  from = null,
  into = POD_NATIVE_DIR,
  pin = readPin(),
  download = ghDownload
} = {}) {
  if (from) {
    if (statSync(from).isDirectory()) {
      install(from, into, { from })
    } else {
      if (basename(from) === pin.asset && pin.sha256 && sha256File(from) !== pin.sha256) {
        throw new Error(`${from} does not match the pinned sha256 ${pin.sha256}`)
      }
      unpack(from, into, { from })
    }
    return { app: join(into, APP), source: from }
  }
  assertDownloadPin(pin)
  const stampPath = join(into, STAMP)
  if (existsSync(stampPath) && JSON.parse(readFileSync(stampPath, 'utf8')).sha256 === pin.sha256) {
    assertApp(join(into, APP))
    return { app: join(into, APP), source: 'cached' }
  }
  const work = mkdtempSync(join(tmpdir(), 'pod-native-download-'))
  try {
    const zip = download(pin, work)
    const actual = sha256File(zip)
    if (actual !== pin.sha256) {
      throw new Error(
        `${pin.repository} ${pin.tag} ${pin.asset}: sha256 ${actual}, pinned ${pin.sha256}`
      )
    }
    unpack(zip, into, { tag: pin.tag, sha256: pin.sha256 })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { app: join(into, APP), source: `${pin.repository} ${pin.tag}` }
}

// Why realpath: run through a symlinked path, a plain compare skips the fetch and exits 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const i = process.argv.indexOf('--from')
  try {
    const { app, source } = fetchPodNative({ from: i === -1 ? null : process.argv[i + 1] })
    console.log(`PodNative from ${source}: ${app}`)
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}
