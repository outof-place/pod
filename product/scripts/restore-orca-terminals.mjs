#!/usr/bin/env node
// Moves the terminal daemons the product took over from Orca (first-run "Move running terminals
// from Orca") back into Orca's profile, so Orca reopens those terminals again.
//
//   node product/scripts/restore-orca-terminals.mjs [<product userData>]
//   ELECTRON_RUN_AS_NODE=1 /Applications/Pod.app/Contents/MacOS/Pod \
//     /Applications/Pod.app/Contents/Resources/restore-orca-terminals.mjs
//
// Quit the product first: it refuses while the product runs, since its terminals hold those daemons.
// A daemon is skipped, never overwritten, when Orca already started a fresh one at the same path.
import {
  existsSync,
  linkSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARKER = 'product-profile-migration.json'

function identityUserDataName() {
  for (const path of [
    join(import.meta.dirname, 'product-identity.json'),
    join(import.meta.dirname, '..', 'identity.json')
  ]) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8')).userDataName
    }
  }
  throw new Error('no product identity next to this script; pass the product userData path')
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function runningPid(userData) {
  try {
    const target = readlinkSync(join(userData, 'SingletonLock'))
    const pid = Number.parseInt(target.slice(target.lastIndexOf('-') + 1), 10)
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** Restores every recorded daemon it can; returns { restored, skipped } or { blocked }. */
export function restoreOrcaTerminals(userData) {
  const pid = runningPid(userData)
  if (pid !== null) {
    return { blocked: `the product is running (pid ${pid}); quit it first` }
  }
  const markerPath = join(userData, MARKER)
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  const moved = Array.isArray(marker.daemonHandover?.moved) ? marker.daemonHandover.moved : []
  const restored = []
  const skipped = []
  const remaining = []
  for (const daemon of moved) {
    const { protocol, files, from, to } = daemon
    if (files.some((file) => existsSync(join(from, file)))) {
      skipped.push({ protocol, reason: 'orca-endpoint-exists' })
      remaining.push(daemon)
    } else if (!files.every((file) => existsSync(join(to, file)))) {
      // The daemon ended and cleaned up, or the product removed its stale files.
      skipped.push({ protocol, reason: 'gone' })
    } else {
      // Why link, then unlink: link never replaces an existing name.
      for (const file of files) {
        linkSync(join(to, file), join(from, file))
      }
      for (const file of files) {
        unlinkSync(join(to, file))
      }
      restored.push(protocol)
    }
  }
  marker.daemonHandover = {
    ...marker.daemonHandover,
    moved: remaining,
    restored: [...(marker.daemonHandover?.restored ?? []), ...restored],
    restoredAt: new Date().toISOString()
  }
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  return { restored, skipped }
}

if (process.argv[1] === import.meta.filename) {
  const userData =
    process.argv[2] ?? join(homedir(), 'Library', 'Application Support', identityUserDataName())
  const result = restoreOrcaTerminals(userData)
  if (result.blocked) {
    console.error(`restore-orca-terminals: ${result.blocked}`)
    process.exit(2)
  }
  console.log(`restored daemon protocols: ${result.restored.join(', ') || 'none'}`)
  for (const { protocol, reason } of result.skipped) {
    console.log(`skipped v${protocol}: ${reason}`)
  }
  process.exit(result.skipped.some(({ reason }) => reason !== 'gone') ? 1 : 0)
}
