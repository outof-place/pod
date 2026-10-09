#!/usr/bin/env node
// Re-hashes files listed in electron-builder's latest-mac.yml after they changed on disk.
// Stapling a notarization ticket onto the DMG rewrites it, so its sha512/size in the update
// manifest would otherwise be stale (electron-updater on macOS downloads the zip, but the
// manifest should still describe every published file truthfully).
//
//   node product/scripts/refresh-latest-mac-yml.mjs <dist dir>
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const YAML = require('yaml')

const distDir = process.argv[2]
if (!distDir) {
  console.error('usage: refresh-latest-mac-yml.mjs <dist dir>')
  process.exit(2)
}
const manifestPath = join(distDir, 'latest-mac.yml')
const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'))

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

for (const file of manifest.files ?? []) {
  const path = join(distDir, file.url)
  file.sha512 = sha512(path)
  file.size = statSync(path).size
}
// The top-level path/sha512 mirror the primary (zip) entry.
if (manifest.path) {
  manifest.sha512 = sha512(join(distDir, manifest.path))
}
writeFileSync(manifestPath, YAML.stringify(manifest))
console.log(
  `[latest-mac.yml] refreshed ${manifest.files?.length ?? 0} file hashes in ${manifestPath}`
)
