import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { removeHostTree } from '../host-tree-removal'
import type { RelocatedDaemonHost } from './daemon-host-relocation'
import { daemonHostStagingName } from './daemon-host-reclaim'
import { assessDarwinDaemonHost } from './daemon-host-darwin-assess'
import { reportDaemonHost } from './daemon-host-darwin-report'
import { runHostTool, type HostToolMode } from './daemon-host-darwin-tools'
import { freeBytes, volumeCanClone } from './daemon-host-darwin-volume'
import {
  CODE_RESOURCES_REL,
  DARWIN_HOST_MARKER_NAME,
  INFO_PLIST_REL,
  darwinBundleFingerprint,
  darwinTreeStamp,
  readDarwinDaemonHostMarker,
  type DarwinDaemonHostMarker
} from './daemon-host-darwin-bundle-identity'

// macOS counterpart of daemon-host-relocation.ts: an in-place update deletes the old bundle under a
// surviving daemon, so it forks from an APFS clone of the runtime bundle in userData (~0 disk while
// the source exists). Fail-open: any failure logs one line and the daemon forks from the bundle.

// Why .noindex and the marker: keeps Spotlight from indexing 5k+ files per clone.
const HOST_SUBDIR = 'daemon-host.noindex'
const NEVER_INDEX_NAME = '.metadata_never_index'
const COPY_TIMEOUT_MS = 120_000
const VERIFY_TIMEOUT_MS = 120_000
// A full copy (no clone support) must leave this much free space behind it.
const FULL_COPY_HEADROOM_BYTES = 2 * 1024 ** 3

export type DarwinBundleSource = {
  bundleDir: string
  bundleName: string
  executableRelPath: string
  entryRelPath: string
}

/** Packaged Electron on macOS, the only shape whose bundle an in-place update deletes. */
export function isPackagedElectronDarwin(): boolean {
  const environment = getAppEnvironment()
  return (
    process.platform === 'darwin' &&
    environment.isPackaged() &&
    environment.getAppPath().includes('app.asar')
  )
}

/** This profile's clone root; the only tree the darwin prune may reclaim. */
export function getDarwinDaemonHostRootDir(): string {
  return join(getAppEnvironment().getPath('userData'), HOST_SUBDIR)
}

// The running bundle, derived from `<bundle>.app/Contents/MacOS/<exe>`, or null for any other layout.
export function collectDarwinBundleSource(entryPath: string): DarwinBundleSource | null {
  if (!isPackagedElectronDarwin()) {
    return null
  }
  const macosDir = dirname(process.execPath)
  const contentsDir = dirname(macosDir)
  const bundleDir = dirname(contentsDir)
  if (
    basename(macosDir) !== 'MacOS' ||
    basename(contentsDir) !== 'Contents' ||
    !bundleDir.endsWith('.app') ||
    !existsSync(join(bundleDir, CODE_RESOURCES_REL))
  ) {
    return null
  }
  const entryRelPath = relative(bundleDir, entryPath)
  if (entryRelPath.startsWith(`..${sep}`) || isAbsolute(entryRelPath)) {
    return null
  }
  return {
    bundleDir,
    bundleName: basename(bundleDir),
    executableRelPath: relative(bundleDir, process.execPath),
    entryRelPath
  }
}

// Why not `.app`: LaunchServices registers an app bundle the first time its main executable runs
// (.noindex or not), and a registered clone competes with the installed app for `open -b`.
export function cloneDirName(bundleName: string): string {
  return bundleName.replace(/\.app$/, '')
}

function hostPaths(buildDir: string, marker: DarwinDaemonHostMarker): RelocatedDaemonHost {
  const bundleDir = join(buildDir, cloneDirName(marker.bundleName))
  return {
    execPath: join(bundleDir, marker.executableRelPath),
    entryPath: join(bundleDir, marker.entryRelPath)
  }
}

// Published builds of this version whose marker names this exact source, newest first.
function matchingBuilds(
  versionRoot: string,
  source: DarwinBundleSource,
  version: string,
  fingerprint: string
): { buildDir: string; marker: DarwinDaemonHostMarker }[] {
  let names: string[]
  try {
    names = readdirSync(versionRoot).filter((name) => name.startsWith('build-'))
  } catch {
    return []
  }
  return names
    .map((name) => ({
      buildDir: join(versionRoot, name),
      marker: readDarwinDaemonHostMarker(join(versionRoot, name))
    }))
    .filter(
      (build): build is { buildDir: string; marker: DarwinDaemonHostMarker } =>
        build.marker !== null &&
        build.marker.version === version &&
        build.marker.fingerprint === fingerprint &&
        build.marker.bundleName === source.bundleName &&
        build.marker.executableRelPath === source.executableRelPath &&
        build.marker.entryRelPath === source.entryRelPath
    )
    .sort((left, right) => right.marker.completedAt.localeCompare(left.marker.completedAt))
}

async function findDarwinDaemonHost(
  versionRoot: string,
  source: DarwinBundleSource,
  version: string,
  fingerprint: string
): Promise<RelocatedDaemonHost | null> {
  for (const { buildDir, marker } of matchingBuilds(versionRoot, source, version, fingerprint)) {
    const bundleDir = join(buildDir, cloneDirName(marker.bundleName))
    try {
      if (
        darwinBundleFingerprint(bundleDir, marker.executableRelPath) === fingerprint &&
        (await darwinTreeStamp(bundleDir)).stamp === marker.treeStamp
      ) {
        reportDaemonHost('reused', `forking from ${buildDir}`)
        return hostPaths(buildDir, marker)
      }
    } catch {
      // A vanished or unreadable clone is skipped; a fresh one is cloned below.
    }
    reportDaemonHost('ignored', `ignoring ${buildDir}: it changed since it was verified`)
  }
  return null
}

/** True when the running bundle relocates and has no published clone yet (marker only, no walk). */
export function darwinDaemonHostNeedsClone(entryPath: string): boolean {
  const source = collectDarwinBundleSource(entryPath)
  if (!source) {
    return false
  }
  try {
    const version = getAppEnvironment().getVersion()
    const fingerprint = darwinBundleFingerprint(source.bundleDir, source.executableRelPath)
    const versionRoot = join(getDarwinDaemonHostRootDir(), version)
    return matchingBuilds(versionRoot, source, version, fingerprint).length === 0
  } catch {
    return false
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** `chmod -R u+w` first: a clone keeps read-only dirs from the bundle, which block unlinking. */
export async function removeDarwinDaemonHostTree(
  dir: string,
  mode: HostToolMode = {}
): Promise<boolean> {
  try {
    await runHostTool('/bin/chmod', ['-R', 'u+w', dir], 30_000, mode)
    await removeHostTree(dir)
    return true
  } catch {
    return false
  }
}

async function removeStaging(staging: string, mode: HostToolMode): Promise<void> {
  // A failed removal is retried by the prune once this writer has exited.
  await removeDarwinDaemonHostTree(staging, { background: mode.background })
}

async function cloneDarwinDaemonHost(
  root: string,
  versionRoot: string,
  source: DarwinBundleSource,
  version: string,
  fingerprint: string,
  mode: HostToolMode
): Promise<RelocatedDaemonHost | null> {
  const startedAt = Date.now()
  const nonce = randomBytes(6).toString('hex')
  const staging = join(versionRoot, daemonHostStagingName(process.pid, nonce))
  try {
    mkdirSync(versionRoot, { recursive: true })
    if (!existsSync(join(root, NEVER_INDEX_NAME))) {
      writeFileSync(join(root, NEVER_INDEX_NAME), '')
    }
    mkdirSync(staging)
  } catch (error) {
    reportDaemonHost('bundle', `cannot create ${versionRoot}; forking from the app bundle`, error)
    return null
  }
  const cloned = await volumeCanClone(join(source.bundleDir, INFO_PLIST_REL), staging)
  if (!cloned) {
    const { bytes } = await darwinTreeStamp(source.bundleDir)
    const free = freeBytes(versionRoot)
    if (free < bytes + FULL_COPY_HEADROOM_BYTES) {
      reportDaemonHost(
        'bundle',
        `volume cannot clone and has ${Math.round(free / 1024 ** 2)} MB free for a ${Math.round(bytes / 1024 ** 2)} MB copy; forking from the app bundle`
      )
      await removeStaging(staging, mode)
      return null
    }
    reportDaemonHost(
      'copied',
      `volume cannot clone; making a full ${Math.round(bytes / 1024 ** 2)} MB copy`
    )
  }
  // Why staged as `.app`: macOS assesses a bundle as one, 2-3x cheaper than loose files; the
  // verdict survives the rename to `bundleDir` (no `.app`) before anything can run from it.
  const stagedDir = join(staging, source.bundleName)
  const bundleDir = join(staging, cloneDirName(source.bundleName))
  const copy = await runHostTool(
    '/bin/cp',
    ['-c', '-R', source.bundleDir, stagedDir],
    COPY_TIMEOUT_MS,
    mode
  )
  const copiedAt = Date.now()
  const verify =
    copy.code === 0 && !mode.signal?.aborted
      ? await runHostTool(
          '/usr/bin/codesign',
          ['--verify', '--strict', '--deep', stagedDir],
          VERIFY_TIMEOUT_MS,
          mode
        )
      : null
  if (mode.signal?.aborted) {
    // The app is quitting: the next launch clones again.
    await removeStaging(staging, mode)
    return null
  }
  if (!verify || verify.code !== 0) {
    const failure = verify
      ? `failed seal verification (${firstLine(verify.stderr)})`
      : `could not be copied (${firstLine(copy.stderr) || `exit ${copy.code}`})`
    reportDaemonHost('bundle', `${source.bundleName} ${failure}; forking from the app bundle`)
    await removeStaging(staging, mode)
    return null
  }
  if (mode.background) {
    // Off the spawn path: assessed before publish, so no daemon start from it ever pays.
    await assessDarwinDaemonHost(source.bundleDir, stagedDir, mode)
  }
  try {
    renameSync(stagedDir, bundleDir)
    // Why: the seal proves the copy intact; the fingerprint, that it is the bundle this process runs.
    if (darwinBundleFingerprint(bundleDir, source.executableRelPath) !== fingerprint) {
      throw new Error('the app bundle changed while it was copied')
    }
    const marker: DarwinDaemonHostMarker = {
      version,
      fingerprint,
      bundleName: source.bundleName,
      executableRelPath: source.executableRelPath,
      entryRelPath: source.entryRelPath,
      treeStamp: (await darwinTreeStamp(bundleDir)).stamp,
      cloned,
      completedAt: new Date().toISOString()
    }
    writeFileSync(join(staging, DARWIN_HOST_MARKER_NAME), JSON.stringify(marker))
    const buildDir = join(versionRoot, `build-${fingerprint.slice(0, 16)}-${nonce}`)
    renameSync(staging, buildDir)
    reportDaemonHost(
      cloned ? 'cloned' : 'copied',
      `${cloned ? 'cloned' : 'copied'} ${source.bundleName} ${version} to ${buildDir} in ${copiedAt - startedAt} ms, verified in ${Date.now() - copiedAt} ms`
    )
    if (!mode.background) {
      // Not awaited: a spawn waiting for this clone forks now; the next start from it is the gain.
      void assessDarwinDaemonHost(
        source.bundleDir,
        join(buildDir, cloneDirName(source.bundleName)),
        mode
      ).catch(() => {})
    }
    return hostPaths(buildDir, marker)
  } catch (error) {
    reportDaemonHost('bundle', `cannot publish ${staging}; forking from the app bundle`, error)
    await removeStaging(staging, mode)
    return null
  }
}

let inflight: Promise<RelocatedDaemonHost | null> | null = null

/** Verified clone to fork the daemon from, cloned on first use; null forks from the bundle. */
export function materializeDarwinDaemonHost(
  entryPath: string,
  mode: HostToolMode = {}
): Promise<RelocatedDaemonHost | null> {
  inflight ??= (async () => {
    const source = collectDarwinBundleSource(entryPath)
    if (!source) {
      return null
    }
    try {
      const version = getAppEnvironment().getVersion()
      const fingerprint = darwinBundleFingerprint(source.bundleDir, source.executableRelPath)
      const root = getDarwinDaemonHostRootDir()
      const versionRoot = join(root, version)
      return (
        (await findDarwinDaemonHost(versionRoot, source, version, fingerprint)) ??
        (await cloneDarwinDaemonHost(root, versionRoot, source, version, fingerprint, mode))
      )
    } catch (error) {
      reportDaemonHost('bundle', 'relocation failed; forking from the app bundle', error)
      return null
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}
