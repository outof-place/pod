#!/usr/bin/env node
// Puts the claude-acc payload into resources/claude-acc, which the Pod macOS build ships as
// Contents/Resources/claude-acc (product/claude-acc-resources.cjs). The release pin lives in
// config/claude-acc-payload.json: tag, asset and sha256 of the tarball claude-acc's
// scripts/payload.sh attached to that GitHub release.
//
//   node config/scripts/fetch-claude-acc-payload.mjs            download the pinned tarball, verify, unpack
//   node config/scripts/fetch-claude-acc-payload.mjs --from X   X = an unpacked payload dir or a tarball
//                                                               (local claude-acc builds; checked against the
//                                                               pin only when X is the pinned asset)
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
export const PAYLOAD_DIR = join(ROOT, 'resources', 'claude-acc')
const PIN = join(ROOT, 'config', 'claude-acc-payload.json')
const STAMP = '.payload-source.json'
const SHA256 = /^[0-9a-f]{64}$/

export function readPin(path = PIN) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['repository', 'tag', 'asset']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(`claude-acc payload pin: "${key}" is missing`)
    }
  }
  return pin
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A payload is usable when setup.sh and VERSION are where Pod's lifecycle looks for them. */
export function assertPayload(dir) {
  for (const name of ['VERSION', 'setup.sh', 'owner.py', 'Claude Acc.app', 'claude-acc-hook']) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`claude-acc payload ${dir} has no ${name}`)
    }
  }
  return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
}

function unpack(tarball, into) {
  const work = mkdtempSync(join(tmpdir(), 'claude-acc-payload-'))
  try {
    const done = spawnSync('/usr/bin/tar', ['-xzf', tarball, '-C', work], { encoding: 'utf8' })
    if (done.status !== 0) {
      throw new Error(`tar -xzf ${tarball}: ${done.stderr}`)
    }
    const dir = join(work, 'claude-acc')
    assertPayload(dir)
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

/** @param {{ from?: string | null, into?: string, pin?: { repository: string, tag: string, asset: string, sha256: string | null }, download?: typeof fetch }} [options] */
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
      if (basename(from) === pin.asset && pin.sha256 && sha256File(from) !== pin.sha256) {
        throw new Error(`${from} does not match the pinned sha256 ${pin.sha256}`)
      }
      unpack(from, into)
    }
    writeFileSync(join(into, STAMP), `${JSON.stringify({ from })}\n`)
    return { version: assertPayload(into), source: from }
  }
  if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) {
    throw new Error(
      'config/claude-acc-payload.json has no sha256 yet: pin a released payload, or use --from <payload>'
    )
  }
  const stamp = join(into, STAMP)
  if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).sha256 === pin.sha256) {
    return { version: assertPayload(into), source: 'cached' }
  }
  const url = `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin.asset}`
  const response = await download(url)
  if (!response.ok) {
    throw new Error(`GET ${url}: ${response.status}`)
  }
  const work = mkdtempSync(join(tmpdir(), 'claude-acc-download-'))
  try {
    const tarball = join(work, pin.asset)
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
    const actual = sha256File(tarball)
    if (actual !== pin.sha256) {
      throw new Error(`${url}: sha256 ${actual}, pinned ${pin.sha256}`)
    }
    unpack(tarball, into)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(stamp, `${JSON.stringify({ tag: pin.tag, sha256: pin.sha256 })}\n`)
  return { version: assertPayload(into), source: url }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const i = process.argv.indexOf('--from')
  fetchPayload({ from: i === -1 ? null : process.argv[i + 1] })
    .then(({ version, source }) => console.log(`claude-acc payload ${version} from ${source}`))
    .catch((error) => {
      console.error(String(error.message ?? error))
      process.exit(1)
    })
}
