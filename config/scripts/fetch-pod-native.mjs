#!/usr/bin/env node
// Fetches PodNative (Pod's native UI, the private outof-place/pod-native), which the Pod macOS build
// ships as Contents/Helpers/PodNative.app (product/pod-native-embed.cjs). The pin in
// config/pod-native.json names a release asset: a zip of the app built at `revision`. gh downloads
// it, since the repository is private. It unpacks under ~/Library/Caches/codes.pod.release, outside
// the worktree, so neither app.asar nor Spotlight and LaunchServices ever see the copy.
//
//   node config/scripts/fetch-pod-native.mjs            download the pinned zip, verify, unpack
//   node config/scripts/fetch-pod-native.mjs --from X   X = a PodNative.app or a zip of one (local
//                                                       builds, unpacked as "local"; checked against
//                                                       the pin only when X is the pinned asset)
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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const {
  POD_NATIVE_APP,
  podNativeCacheDir,
  podNativeRevision,
  readPodNativePin
} = require('../../product/pod-native-embed.cjs')
const STAMP = '.source.json'
const SHA256 = /^[0-9a-f]{64}$/

export const readPin = readPodNativePin

/** Only a download needs the whole pin; --from works with any local build. */
function assertDownloadPin(pin) {
  for (const key of ['repository', 'tag', 'asset', 'revision']) {
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

/** A pinned build must be the commit the pin names, not just any zip with the right hash. */
function assertApp(app, revision) {
  if (!existsSync(join(app, 'Contents', 'Info.plist'))) {
    throw new Error(`${app} is not an app bundle`)
  }
  if (revision && podNativeRevision(app) !== revision) {
    throw new Error(`${app} is revision ${podNativeRevision(app)}, the pin says ${revision}`)
  }
}

/** Copies `app` to <into>/PodNative.app through a sibling folder, so a failed run keeps the old copy. */
function install(app, into, stamp, revision) {
  assertApp(app, revision)
  const next = `${into}.next`
  rmSync(next, { recursive: true, force: true })
  mkdirSync(next, { recursive: true })
  // Why: Spotlight would index the cache and LaunchServices register its codes.pod.native.
  writeFileSync(join(dirname(into), '.metadata_never_index'), '')
  execFileSync('/usr/bin/ditto', [app, join(next, POD_NATIVE_APP)])
  // Why: a browser download's quarantine would follow the app into Pod.app (an APFS clone keeps it).
  execFileSync('/usr/bin/xattr', ['-cr', join(next, POD_NATIVE_APP)])
  writeFileSync(join(next, STAMP), `${JSON.stringify(stamp)}\n`)
  rmSync(into, { recursive: true, force: true })
  renameSync(next, into)
}

function unpack(zip, into, stamp, revision) {
  const work = mkdtempSync(join(tmpdir(), 'pod-native-unpack-'))
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', '--noqtn', zip, work])
    install(join(work, POD_NATIVE_APP), into, stamp, revision)
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

/** @param {{ from?: string | null, into?: string, pin?: { repository: string, tag: string, asset: string, sha256: string | null, revision?: string | null }, download?: typeof ghDownload }} [options] */
export function fetchPodNative({ from = null, pin = readPin(), into, download = ghDownload } = {}) {
  if (from) {
    const target = into ?? podNativeCacheDir('local')
    const pinned = basename(from) === pin.asset && pin.sha256
    if (statSync(from).isDirectory()) {
      install(from, target, { from })
    } else {
      if (pinned && sha256File(from) !== pin.sha256) {
        throw new Error(`${from} does not match the pinned sha256 ${pin.sha256}`)
      }
      unpack(from, target, { from }, pinned ? pin.revision : null)
    }
    return { app: join(target, POD_NATIVE_APP), source: from }
  }
  assertDownloadPin(pin)
  const target = into ?? podNativeCacheDir(pin.sha256)
  const stampPath = join(target, STAMP)
  if (existsSync(stampPath) && JSON.parse(readFileSync(stampPath, 'utf8')).sha256 === pin.sha256) {
    assertApp(join(target, POD_NATIVE_APP), pin.revision)
    return { app: join(target, POD_NATIVE_APP), source: 'cached' }
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
    unpack(zip, target, { tag: pin.tag, sha256: pin.sha256 }, pin.revision)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { app: join(target, POD_NATIVE_APP), source: `${pin.repository} ${pin.tag}` }
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
