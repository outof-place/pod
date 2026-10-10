// Release size and content gate. electron-builder packs the repository root into app.asar minus
// upstream's denylist, so anything left in the worktree ships: on 2026-10-10 two parked dist-*
// folders (old Pod.apps) grew app.asar from 140 MB to 2.5 GB. afterPack checks the asar before
// signing; release.sh checks the DMG before notarizing.
//
//   node product/release-bundle-gate.cjs --dmg <path>
const { statSync } = require('node:fs')
const { join } = require('node:path')

const MB = 1024 * 1024
// 0.0.1-test (2718f89dbd): app.asar 140 MB, DMG 236 MB.
const MAX_ASAR_BYTES = 400 * MB
const MAX_DMG_BYTES = 350 * MB

// Local outputs a worktree accumulates: build output parked beside dist/, test reports, caches.
const PRODUCT_FILE_EXCLUSIONS = [
  '!dist-*{,/**/*}',
  '!test-results{,/**/*}',
  '!playwright-report{,/**/*}',
  '!.ruff_cache{,/**/*}'
]
const FORBIDDEN_TOP_LEVEL = /^(dist|dist-.*|test-results|playwright-report)$/
// Why dot folders too: caches are hidden folders, while the dot files upstream ships are configs.
const HIDDEN = /^\..+/

function megabytes(bytes) {
  return `${Math.round(bytes / MB)} MB`
}

/** Entries of an asar listing (paths starting with `/`) that must never ship. */
function forbiddenAsarEntries(listing) {
  const tops = new Set()
  const folders = new Set()
  for (const entry of listing) {
    const [, top, child] = entry.split(/[\\/]/)
    if (top) {
      tops.add(top)
      if (child) {
        folders.add(top)
      }
    }
  }
  return [...tops]
    .filter((top) => FORBIDDEN_TOP_LEVEL.test(top) || (HIDDEN.test(top) && folders.has(top)))
    .sort()
}

function assertAppAsar(resourcesDir, listPackage = require('@electron/asar').listPackage) {
  const asar = join(resourcesDir, 'app.asar')
  const { size } = statSync(asar)
  const forbidden = forbiddenAsarEntries(listPackage(asar, { isPack: false }))
  if (forbidden.length > 0) {
    throw new Error(
      `product: app.asar packs ${forbidden.join(', ')}; move them out of the worktree`
    )
  }
  if (size > MAX_ASAR_BYTES) {
    throw new Error(`product: app.asar is ${megabytes(size)}, over ${megabytes(MAX_ASAR_BYTES)}`)
  }
}

function assertDmgSize(dmg) {
  const { size } = statSync(dmg)
  if (size > MAX_DMG_BYTES) {
    throw new Error(`product: ${dmg} is ${megabytes(size)}, over ${megabytes(MAX_DMG_BYTES)}`)
  }
}

if (require.main === module) {
  const [flag, path] = process.argv.slice(2)
  if (flag !== '--dmg' || !path) {
    console.error('usage: node product/release-bundle-gate.cjs --dmg <path>')
    process.exit(2)
  }
  try {
    assertDmgSize(path)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

module.exports = {
  MAX_ASAR_BYTES,
  MAX_DMG_BYTES,
  PRODUCT_FILE_EXCLUSIONS,
  assertAppAsar,
  assertDmgSize,
  forbiddenAsarEntries
}
