// node-pty leftovers the packaged runtime never reads. node-pty 1.1.0 loads the first addon of
// build/Release, build/Debug, prebuilds/<platform>-<arch> that loads and spawns through the
// spawn-helper beside it; the daemon maps build/Release/pty.node. The rest is upstream's prebuild
// without Orca's pty.cc patch (reached only when the patched build fails, which it then hides),
// @electron/rebuild's bin/<platform>-<arch>-<abi> copy, compiler objects, gyp files and stamps.
// Each Mach-O file left in the bundle is one more file macOS assesses before first launch.
const { existsSync, openSync, readSync, closeSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const CPU_TYPE = { arm64: 0x0100000c, x64: 0x01000007 }
// What the runtime loads: the addon and the helper it spawns every PTY through.
const NODE_PTY_RUNTIME_FILES = ['pty.node', 'spawn-helper']

function isBuildLeftover(name) {
  return (
    name === 'Makefile' ||
    name.endsWith('.Makefile') ||
    name.endsWith('.mk') ||
    name === 'config.gypi' ||
    name === 'gyp-mac-tool'
  )
}

function isReleaseLeftover(name) {
  return ['obj.target', '.deps', '.forge-meta'].includes(name) || name.startsWith('node-addon-api@')
}

/** Whether the Mach-O file at `path`, thin or fat, holds an `arch` slice. */
function machOHasArch(path, arch) {
  const header = Buffer.alloc(8 + 20 * 16)
  const fd = openSync(path, 'r')
  let length
  try {
    length = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  if (length < 8) {
    return false
  }
  if (header.readUInt32LE(0) === MH_MAGIC_64) {
    return header.readInt32LE(4) === CPU_TYPE[arch]
  }
  if (header.readUInt32BE(0) !== FAT_MAGIC) {
    return false
  }
  const count = Math.min(header.readUInt32BE(4), 16)
  for (let i = 0; i < count && 8 + 20 * i + 4 <= length; i++) {
    if (header.readInt32BE(8 + 20 * i) === CPU_TYPE[arch]) {
      return true
    }
  }
  return false
}

/** Removes what node-pty's loader never reads; throws when the source build can't serve `arch`. */
function prunePodNodePty(resourcesDir, arch) {
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty')
  const releaseDir = join(nodePtyDir, 'build', 'Release')
  // Why throw rather than keep the prebuild: Pod ships the patched source build or nothing.
  for (const name of NODE_PTY_RUNTIME_FILES) {
    const path = join(releaseDir, name)
    if (!existsSync(path) || !machOHasArch(path, arch)) {
      throw new Error(`product: ${path} is missing or has no ${arch} slice`)
    }
  }
  const removed = []
  const remove = (path) => {
    rmSync(path, { recursive: true, force: true })
    removed.push(path.slice(nodePtyDir.length + 1))
  }
  for (const name of ['prebuilds', 'bin']) {
    if (existsSync(join(nodePtyDir, name))) {
      remove(join(nodePtyDir, name))
    }
  }
  for (const name of readdirSync(join(nodePtyDir, 'build'))) {
    if (isBuildLeftover(name)) {
      remove(join(nodePtyDir, 'build', name))
    }
  }
  for (const name of readdirSync(releaseDir)) {
    if (isReleaseLeftover(name)) {
      remove(join(releaseDir, name))
    }
  }
  for (const name of readdirSync(nodePtyDir)) {
    if (name.startsWith('node-addon-api@')) {
      remove(join(nodePtyDir, name))
    }
  }
  return removed
}

module.exports = { machOHasArch, prunePodNodePty }
