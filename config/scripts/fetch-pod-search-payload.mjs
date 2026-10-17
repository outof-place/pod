#!/usr/bin/env node
// Puts the pod-search payload into resources/pod-search, which the Pod macOS build ships as
// Contents/Resources/pod-search (config/pod-search-extra-resources.cjs): og, ogd, ogctl and a plain
// ripgrep 15.2.0, the PATH shims rg and ugrep (links to og), licences and BUILD.json. The release pin
// lives in config/pod-search-payload.json: tag, asset and sha256 of the tarball pod-search's
// scripts/payload.sh built, and the pod-search commit it was built from.
//
//   node config/scripts/fetch-pod-search-payload.mjs            download the pinned tarball, verify, unpack
//   node config/scripts/fetch-pod-search-payload.mjs --from X   X = an unpacked payload dir or a tarball
//                                                               (local pod-search builds; checked against the
//                                                               pin only when X is the pinned asset)
//   node config/scripts/fetch-pod-search-payload.mjs --if-pinned   as the first form, but a pin without a sha256 yet
//                                                               is a no-op (pod-check and release.sh: a build
//                                                               before the first released payload ships without it)
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
export const PAYLOAD_DIR = join(ROOT, 'resources', 'pod-search')
const PIN = join(ROOT, 'config', 'pod-search-payload.json')
const STAMP = '.payload-source.json'
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const BINARIES = ['og', 'ogd', 'ogctl', 'rg']
const SHIMS = { 'rg-shim/rg': '../bin/og', 'ugrep-shim/ugrep': '../bin/og' }

export function readPin(path = PIN) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['repository', 'tag', 'asset']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(`pod-search payload pin: "${key}" is missing`)
    }
  }
  return pin
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * A payload is usable when its four binaries are executable files, both shims are links to og
 * (Pod puts rg-shim first on an agent's PATH; og finds the real rg through OG_REAL_RG) and
 * BUILD.json names its commit. Returns that commit.
 */
export function assertPayload(dir) {
  for (const name of BINARIES) {
    // lstat: a link in bin/ would sign and seal whatever it points at.
    const info = lstatSync(join(dir, 'bin', name), { throwIfNoEntry: false })
    if (!info?.isFile() || (info.mode & 0o111) === 0) {
      throw new Error(`pod-search payload ${dir} has no executable bin/${name}`)
    }
  }
  for (const [link, target] of Object.entries(SHIMS)) {
    const path = join(dir, link)
    if (!existsSync(path) || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) {
      throw new Error(`pod-search payload ${dir}: ${link} is not a link to ${target}`)
    }
  }
  if (!existsSync(join(dir, 'licenses', 'ripgrep-LICENSE-MIT'))) {
    throw new Error(`pod-search payload ${dir} has no licenses/ripgrep-LICENSE-MIT`)
  }
  const build = JSON.parse(readFileSync(join(dir, 'BUILD.json'), 'utf8'))
  if (!COMMIT.test(build.commit ?? '')) {
    throw new Error(`pod-search payload ${dir}: BUILD.json names no commit`)
  }
  return build.commit
}

function unpack(tarball, into, pin) {
  const work = mkdtempSync(join(tmpdir(), 'pod-search-payload-'))
  try {
    const done = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' })
    if (done.status !== 0) {
      throw new Error(`tar -xzf ${tarball}: ${done.stderr}`)
    }
    const dir = join(work, 'pod-search')
    const commit = assertPayload(dir)
    if (pin?.commit && commit !== pin.commit) {
      throw new Error(`${tarball} was built from ${commit}, pinned ${pin.commit}`)
    }
    install(dir, into)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function install(dir, into) {
  const next = `${into}.next`
  rmSync(next, { recursive: true, force: true })
  cpSync(dir, next, { recursive: true, verbatimSymlinks: true })
  rmSync(into, { recursive: true, force: true })
  renameSync(next, into)
}

/** @param {{ from?: string | null, into?: string, pin?: { repository: string, tag: string, asset: string, sha256: string | null, commit?: string | null }, download?: typeof fetch }} [options] */
export async function fetchPayload({
  from = null,
  into = PAYLOAD_DIR,
  pin = readPin(),
  download = fetch
} = {}) {
  if (from) {
    if (statSync(from).isDirectory()) {
      assertPayload(from)
      install(from, into)
    } else {
      const pinned = basename(from) === pin.asset
      if (pinned && pin.sha256 && sha256File(from) !== pin.sha256) {
        throw new Error(`${from} does not match the pinned sha256 ${pin.sha256}`)
      }
      unpack(from, into, pinned ? pin : null)
    }
    writeFileSync(join(into, STAMP), `${JSON.stringify({ from })}\n`)
    return { commit: assertPayload(into), source: from }
  }
  if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) {
    throw new Error(
      'config/pod-search-payload.json has no sha256 yet: pin a released payload, or use --from <payload>'
    )
  }
  const stamp = join(into, STAMP)
  if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).sha256 === pin.sha256) {
    return { commit: assertPayload(into), source: 'cached' }
  }
  const url = `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin.asset}`
  const response = await download(url)
  if (!response.ok) {
    throw new Error(`GET ${url}: ${response.status}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'pod-search-download-'))
  try {
    const tarball = join(work, pin.asset)
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
    const actual = sha256File(tarball)
    if (actual !== pin.sha256) {
      throw new Error(`${url}: sha256 ${actual}, pinned ${pin.sha256}`)
    }
    unpack(tarball, into, pin)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(stamp, `${JSON.stringify({ tag: pin.tag, sha256: pin.sha256 })}\n`)
  return { commit: assertPayload(into), source: url }
}

/** Whether the pin names a released payload yet (its sha256). */
export function isPinned(pin = readPin()) {
  return typeof pin.sha256 === 'string' && SHA256.test(pin.sha256)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (process.argv.includes('--if-pinned') && !isPinned()) {
    console.log('pod-search payload: config/pod-search-payload.json pins no release yet; nothing to fetch')
    process.exit(0)
  }
  const i = process.argv.indexOf('--from')
  fetchPayload({ from: i === -1 ? null : process.argv[i + 1] })
    .then(({ commit, source }) => console.log(`pod-search payload ${commit} from ${source}`))
    .catch((error) => {
      console.error(String(error.message ?? error))
      process.exit(1)
    })
}
