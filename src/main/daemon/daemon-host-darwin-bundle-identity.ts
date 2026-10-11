import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const DARWIN_HOST_MARKER_NAME = '.materialized.json'
export const CODE_RESOURCES_REL = join('Contents', '_CodeSignature', 'CodeResources')
export const INFO_PLIST_REL = join('Contents', 'Info.plist')

export type DarwinDaemonHostMarker = {
  version: string
  fingerprint: string
  bundleName: string
  executableRelPath: string
  entryRelPath: string
  treeStamp: string
  cloned: boolean
  completedAt: string
}

// Identity of a signed bundle without hashing 500+ MB: the seal hashes every resource and nested
// code; the main executable and Info.plist are the two files it does not cover.
export function darwinBundleFingerprint(bundleDir: string, executableRelPath: string): string {
  const hash = createHash('sha256')
  for (const rel of [CODE_RESOURCES_REL, INFO_PLIST_REL, executableRelPath]) {
    const bytes = readFileSync(join(bundleDir, rel))
    hash.update(`${rel}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

type FsPromises = typeof fsPromises

// Why original-fs: Electron's fs walks into app.asar with made-up metadata, so the stamp would
// never repeat (same shim as asar-transparent-fs.ts).
function realFs(): FsPromises {
  try {
    const originalFs: unknown = createRequire(__filename)('original-fs')
    return isFsModule(originalFs) ? originalFs.promises : fsPromises
  } catch {
    return fsPromises
  }
}

function isFsModule(value: unknown): value is { promises: FsPromises } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'promises' in value &&
    typeof value.promises === 'object' &&
    value.promises !== null &&
    'lstat' in value.promises &&
    typeof value.promises.lstat === 'function'
  )
}

/** Cheap reuse check (one lstat per entry, ~50 ms for 5.6k entries): any later write changes it. */
export async function darwinTreeStamp(root: string): Promise<{ stamp: string; bytes: number }> {
  const fs = realFs()
  const hash = createHash('sha256')
  let bytes = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = (await fs.readdir(dir)).sort()
    const stats = await Promise.all(
      names.map((name) => fs.lstat(join(dir, name), { bigint: true }))
    )
    for (let index = 0; index < names.length; index++) {
      const stat = stats[index]
      hash.update(
        `${rel}${names[index]}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}\n`
      )
      bytes += Number(stat.size)
    }
    for (let index = 0; index < names.length; index++) {
      if (stats[index].isDirectory()) {
        await walk(join(dir, names[index]), `${rel}${names[index]}/`)
      }
    }
  }
  await walk(root, '')
  return { stamp: hash.digest('hex'), bytes }
}

function isMarker(value: unknown): value is DarwinDaemonHostMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    'fingerprint' in value &&
    typeof value.fingerprint === 'string' &&
    'bundleName' in value &&
    typeof value.bundleName === 'string' &&
    'executableRelPath' in value &&
    typeof value.executableRelPath === 'string' &&
    'entryRelPath' in value &&
    typeof value.entryRelPath === 'string' &&
    'treeStamp' in value &&
    typeof value.treeStamp === 'string' &&
    'cloned' in value &&
    typeof value.cloned === 'boolean' &&
    'completedAt' in value &&
    typeof value.completedAt === 'string'
  )
}

export function readDarwinDaemonHostMarker(buildDir: string): DarwinDaemonHostMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(buildDir, DARWIN_HOST_MARKER_NAME), 'utf8')
    )
    return isMarker(parsed) ? parsed : null
  } catch {
    return null
  }
}
