// A GitHub release tarball pinned by tag, asset and sha256, unpacked into a resources/ directory
// that the Pod macOS build ships. Shared by the claude-acc payload and the embedded Python.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STAMP = '.payload-source.json'
const SHA256 = /^[0-9a-f]{64}$/

/** @typedef {{ repository: string, tag: string, asset: string, sha256: string | null }} ReleasePin */

/** @returns {ReleasePin} */
export function readPin(path, label) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['repository', 'tag', 'asset']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(`${label} pin: "${key}" is missing`)
    }
  }
  return pin
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Swaps `dir` in as `into` in one rename, so a failed copy never leaves half a tree behind. */
export function installDir(dir, into) {
  const next = `${into}.next`
  rmSync(next, { recursive: true, force: true })
  cpSync(dir, next, { recursive: true, verbatimSymlinks: true })
  rmSync(into, { recursive: true, force: true })
  renameSync(next, into)
}

/**
 * Unpacks `tarball`, runs `prepare` on its `topDir` (trim, precompile), checks it with `assert`,
 * and installs that directory as `into`.
 */
export function unpackTarball(tarball, topDir, into, assert, prepare = () => {}) {
  const work = mkdtempSync(join(tmpdir(), 'pod-release-asset-'))
  try {
    const done = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' })
    if (done.status !== 0) {
      throw new Error(`tar -xzf ${tarball}: ${done.stderr}`)
    }
    const dir = join(work, topDir)
    prepare(dir)
    assert(dir)
    installDir(dir, into)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Downloads the pinned asset unless `into` already holds it (per its stamp), verifies the sha256
 * and installs it. Refuses an unpinned sha256 rather than trusting whatever the release serves.
 * @param {{ pin: ReleasePin, label: string, pinPath: string, into: string, topDir: string,
 *   assert: (dir: string) => void, prepare?: (dir: string) => void, download?: typeof fetch }} options
 * @returns {Promise<string>} 'cached', or the URL it downloaded
 */
export async function installPinnedAsset({
  pin,
  label,
  pinPath,
  into,
  topDir,
  assert,
  prepare,
  download = fetch
}) {
  if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) {
    throw new Error(`${pinPath} has no sha256 yet: pin a released ${label}`)
  }
  const stamp = join(into, STAMP)
  if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).sha256 === pin.sha256) {
    assert(into)
    return 'cached'
  }
  const url = `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin.asset}`
  const response = await download(url)
  if (!response.ok) {
    throw new Error(`GET ${url}: ${response.status}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'pod-release-download-'))
  try {
    const tarball = join(work, pin.asset)
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
    const actual = sha256File(tarball)
    if (actual !== pin.sha256) {
      throw new Error(`${url}: sha256 ${actual}, pinned ${pin.sha256}`)
    }
    unpackTarball(tarball, topDir, into, assert, prepare)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(stamp, `${JSON.stringify({ tag: pin.tag, sha256: pin.sha256 })}\n`)
  return url
}
