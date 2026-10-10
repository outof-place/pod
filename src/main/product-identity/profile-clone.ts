import {
  constants,
  copyFileSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync
} from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MOBILE_PAIRING_USERDATA_FILES } from '../runtime/mobile-pairing-files'

// Which parts of a legacy profile the product import clones, when, and how fast.
// Why own walkers over fs.cp: on APFS a per-file clonefile is the whole cost, and fs.cp adds
// several stat/utimes calls per file; measured 4x (sync) and 9x (parallel async) faster.

/**
 * Phones paired with the legacy app: their device tokens and the E2EE keypair would stay valid
 * against the product, and a device registry makes the runtime listen beyond loopback. The relay
 * region and notification dismissals belong to the same pairing, which the product leaves out.
 */
export const SKIPPED_PAIRING_FILES: readonly string[] = [
  ...MOBILE_PAIRING_USERDATA_FILES,
  'orca-relay-region-preference.json',
  'mobile-notification-dismissals.json'
]

// Chromium process locks regenerate; the daemon dir is linked, not copied.
const SKIPPED_TOP_LEVEL = new Set([
  'Crashpad',
  'Shared Dictionary',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'daemon',
  ...SKIPPED_PAIRING_FILES
])
// Chromium caches, in the default session and every browser partition.
const SKIPPED_CHROMIUM_CACHES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'CacheStorage',
  'ScriptCache',
  'Shared Dictionary'
])
/**
 * Cloned after `ready`, behind a progress window, instead of blocking the first frame: browser
 * partitions (~90% of a profile's files) and the large or many-file stores that only services
 * started after `ready` read. Measured on a 22k-file profile: 7.3 s -> 1.0 s before the first frame.
 */
export const DEFERRED_PROFILE_ENTRIES: readonly string[] = [
  'Partitions',
  'ai-vault',
  'speech-models',
  'claude-accounts',
  'codex-accounts',
  'codex-runtime-home',
  'logs'
]

export type ProfileClonePhase = 'essential' | 'deferred'

const CLONE_FLAGS = constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL
const ASYNC_CLONE_CONCURRENCY = 64

/** Whether `segments` (relative to the legacy profile root) belongs to `phase`'s clone. */
export function shouldCloneProfileEntry(
  segments: readonly string[],
  entry: Pick<Dirent, 'isFile' | 'isDirectory' | 'isSymbolicLink'>,
  phase: ProfileClonePhase
): boolean {
  const top = segments[0] ?? ''
  if (SKIPPED_TOP_LEVEL.has(top)) {
    return false
  }
  if (DEFERRED_PROFILE_ENTRIES.includes(top) !== (phase === 'deferred')) {
    return false
  }
  const inChromiumStorage = segments.length === 1 || top === 'Partitions'
  if (inChromiumStorage && SKIPPED_CHROMIUM_CACHES.has(segments.at(-1) ?? '')) {
    return false
  }
  // Sockets and FIFOs belong to running processes and cannot be copied.
  return entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()
}

function isAlreadyThere(error: unknown): boolean {
  return Reflect.get(Object(error), 'code') === 'EEXIST'
}

/** Clones `phase`'s part of `legacyRoot` into `targetRoot`; existing targets are kept. Returns files cloned. */
export function cloneProfileTreeSync(
  legacyRoot: string,
  targetRoot: string,
  phase: ProfileClonePhase
): number {
  let files = 0
  const walk = (segments: string[]): void => {
    const from = join(legacyRoot, ...segments)
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const child = [...segments, entry.name]
      if (!shouldCloneProfileEntry(child, entry, phase)) {
        continue
      }
      const source = join(legacyRoot, ...child)
      const target = join(targetRoot, ...child)
      try {
        if (entry.isDirectory()) {
          mkdirSync(target, { recursive: true, mode: lstatSync(source).mode & 0o777 })
          walk(child)
        } else if (entry.isSymbolicLink()) {
          symlinkSync(readlinkSync(source), target)
        } else {
          copyFileSync(source, target, CLONE_FLAGS)
          files += 1
        }
      } catch (error) {
        if (!isAlreadyThere(error)) {
          throw error
        }
      }
    }
  }
  walk([])
  return files
}

export type CloneProgress = { copied: number; total: number }

/** Async, parallel clone of `entries` (top-level names) for the deferred phase, with progress. */
export async function cloneProfileEntries(
  legacyRoot: string,
  targetRoot: string,
  entries: readonly string[],
  onProgress: (progress: CloneProgress) => void
): Promise<CloneProgress> {
  const files: string[][] = []
  const links: string[][] = []
  const walk = async (segments: string[]): Promise<void> => {
    const source = join(legacyRoot, ...segments)
    await mkdir(join(targetRoot, ...segments), {
      recursive: true,
      mode: (await lstat(source)).mode & 0o777
    })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const child = [...segments, entry.name]
      if (!shouldCloneProfileEntry(child, entry, 'deferred')) {
        continue
      }
      if (entry.isDirectory()) {
        await walk(child)
      } else if (entry.isSymbolicLink()) {
        links.push(child)
      } else {
        files.push(child)
      }
    }
  }
  for (const entry of entries) {
    await walk([entry])
  }
  const progress = { copied: 0, total: files.length }
  onProgress(progress)
  for (const link of links) {
    await symlink(await readlink(join(legacyRoot, ...link)), join(targetRoot, ...link)).catch(
      (error: unknown) => {
        if (!isAlreadyThere(error)) {
          throw error
        }
      }
    )
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const segments = files[next++] ?? []
      try {
        await copyFile(join(legacyRoot, ...segments), join(targetRoot, ...segments), CLONE_FLAGS)
      } catch (error) {
        if (!isAlreadyThere(error)) {
          throw error
        }
      }
      progress.copied += 1
      onProgress(progress)
    }
  }
  await Promise.all(Array.from({ length: ASYNC_CLONE_CONCURRENCY }, worker))
  return progress
}
