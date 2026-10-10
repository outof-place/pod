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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  installDir,
  installPinnedAsset,
  readPin as readReleasePin,
  sha256File,
  STAMP,
  unpackTarball
} from './pinned-release-asset.mjs'

export { sha256File }

const ROOT = join(import.meta.dirname, '..', '..')
export const PAYLOAD_DIR = join(ROOT, 'resources', 'claude-acc')
const PIN = join(ROOT, 'config', 'claude-acc-payload.json')
const SHA256 = /^[0-9a-f]{64}$/

export function readPin(path = PIN) {
  return readReleasePin(path, 'claude-acc payload')
}

/**
 * A payload is usable when setup.sh and VERSION are where Pod's lifecycle looks for them. From
 * 1.31 the menu helper is Pod Menu.app instead of Claude Acc.app.
 */
export function assertPayload(dir) {
  const helper = existsSync(join(dir, 'Pod Menu.app')) ? 'Pod Menu.app' : 'Claude Acc.app'
  for (const name of ['VERSION', 'setup.sh', 'owner.py', helper, 'claude-acc-hook']) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`claude-acc payload ${dir} has no ${name}`)
    }
  }
  return readFileSync(join(dir, 'VERSION'), 'utf8').trim()
}

/** @param {{ from?: string | null, into?: string, pin?: import('./pinned-release-asset.mjs').ReleasePin, download?: typeof fetch }} [options] */
export async function fetchPayload({
  from = null,
  into = PAYLOAD_DIR,
  pin = readPin(),
  download = fetch
} = {}) {
  if (from) {
    if (statSync(from).isDirectory()) {
      assertPayload(from)
      installDir(from, into)
    } else {
      if (basename(from) === pin.asset && pin.sha256 && sha256File(from) !== pin.sha256) {
        throw new Error(`${from} does not match the pinned sha256 ${pin.sha256}`)
      }
      unpackTarball(from, 'claude-acc', into, assertPayload)
    }
    writeFileSync(join(into, STAMP), `${JSON.stringify({ from })}\n`)
    return { version: assertPayload(into), source: from }
  }
  if (typeof pin.sha256 !== 'string' || !SHA256.test(pin.sha256)) {
    throw new Error(
      'config/claude-acc-payload.json has no sha256 yet: pin a released payload, or use --from <payload>'
    )
  }
  const source = await installPinnedAsset({
    pin,
    label: 'claude-acc payload',
    pinPath: 'config/claude-acc-payload.json',
    into,
    topDir: 'claude-acc',
    assert: assertPayload,
    download
  })
  return { version: assertPayload(into), source }
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
