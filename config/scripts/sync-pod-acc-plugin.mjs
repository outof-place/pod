#!/usr/bin/env node
// Copies claude-acc's Orca plugin into Pod's bundled plugins as outof-place.pod-acc and writes
// resources/plugins/distro/distro-plugins.json with its content hash (the hash Orca's
// hashPluginTree computes, which the bundled bootstrap verifies before installing it).
//
//   node config/scripts/sync-pod-acc-plugin.mjs --from <claude-acc checkout or payload dir>
//
// The source is the claude-acc repo root (orca-plugin/ inside) or an unpacked payload
// (scripts/payload.sh output, orca-plugin/ inside as well). Its manifest is rewritten to Pod's
// identity, with the status bar and live panel features merged in (Pod always has them).
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
// Why not plugins/launch: that folder mirrors Orca's marketplace listing one to one
const DISTRO = join(ROOT, 'resources', 'plugins', 'distro')
export const POD_ACC_PUBLISHER = 'outof-place'
export const POD_ACC_ID = 'pod-acc'
export const POD_ACC_KEY = `${POD_ACC_PUBLISHER}.${POD_ACC_ID}`
export const DISTRO_INDEX = 'distro-plugins.json'
const SHIPPED = ['worker.mjs', 'lib', 'panel']

/** Orca's hashPluginTree (src/main/plugins/plugin-content-hash.ts), byte for byte. */
export function hashPluginTree(root) {
  const files = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((l, r) =>
      l.name < r.name ? -1 : l.name > r.name ? 1 : 0
    )
    for (const entry of entries) {
      if (dir === root && entry.name === '.git') {
        continue
      }
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink in plugin: ${full}`)
      }
      if (stat.isDirectory()) {
        walk(full)
      } else if (stat.isFile()) {
        files.push(full)
      }
    }
  }
  walk(root)
  const hash = createHash('sha256')
  hash.update('orca-plugin-tree-v1\0')
  const length = (n) => {
    const b = Buffer.allocUnsafe(8)
    b.writeBigUInt64BE(BigInt(n))
    hash.update(b)
  }
  for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/')
    length(Buffer.byteLength(rel, 'utf8'))
    hash.update(rel, 'utf8')
    const data = readFileSync(file)
    length(data.length)
    hash.update(data)
  }
  return hash.digest('hex')
}

export function podAccManifest(source) {
  const manifest = JSON.parse(readFileSync(join(source, 'orca-plugin.json'), 'utf8'))
  const live = JSON.parse(readFileSync(join(source, 'live-features.json'), 'utf8'))
  return {
    ...manifest,
    id: POD_ACC_ID,
    publisher: POD_ACC_PUBLISHER,
    contributes: { ...manifest.contributes, ...live.contributes },
    capabilities: [...manifest.capabilities, ...live.capabilities]
  }
}

export function syncPodAccPlugin(from, root = DISTRO) {
  const source = existsSync(join(from, 'orca-plugin', 'orca-plugin.json'))
    ? join(from, 'orca-plugin')
    : from
  if (!existsSync(join(source, 'orca-plugin.json'))) {
    throw new Error(`no claude-acc Orca plugin in ${from}`)
  }
  const target = join(root, POD_ACC_KEY)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const name of SHIPPED) {
    cpSync(join(source, name), join(target, name), { recursive: true })
  }
  writeFileSync(
    join(target, 'orca-plugin.json'),
    `${JSON.stringify(podAccManifest(source), null, 2)}\n`
  )
  const contentHash = hashPluginTree(target)
  const index = {
    version: 1,
    plugins: [{ pluginKey: POD_ACC_KEY, path: POD_ACC_KEY, contentHash }]
  }
  writeFileSync(join(root, DISTRO_INDEX), `${JSON.stringify(index, null, 2)}\n`)
  return { target, contentHash }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const i = process.argv.indexOf('--from')
  if (i === -1 || !process.argv[i + 1]) {
    console.error('usage: sync-pod-acc-plugin.mjs --from <claude-acc checkout or payload dir>')
    process.exit(2)
  }
  const { target, contentHash } = syncPodAccPlugin(process.argv[i + 1])
  console.log(`${relative(ROOT, target)} ${contentHash}`)
}
