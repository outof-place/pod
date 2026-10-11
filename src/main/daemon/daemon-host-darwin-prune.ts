import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  getDarwinDaemonHostRootDir,
  darwinDaemonHostNeedsClone,
  isPackagedElectronDarwin,
  materializeDarwinDaemonHost,
  removeDarwinDaemonHostTree
} from './daemon-host-darwin-clone'
import { stagingWriterVerdict } from './daemon-host-reclaim'
import { reportDaemonHost } from './daemon-host-darwin-report'
import { runHostTool, type HostToolMode } from './daemon-host-darwin-tools'
import {
  collectPinnedDaemonVersions,
  type PinnedDaemonVersionsEvidence
} from './daemon-host-relocation'

// Why late: the prune lsofs and the first clone of a version copies and verifies 500+ MB.
const MAINTENANCE_DELAY_MS = 30_000
const LSOF_TIMEOUT_MS = 15_000

// Every main executable under a version dir, published or staging; a live daemon maps one of them.
function versionExecutables(versionDir: string): string[] {
  const executables: string[] = []
  for (const build of safeReaddir(versionDir)) {
    for (const bundle of safeReaddir(join(versionDir, build))) {
      const macosDir = join(versionDir, build, bundle, 'Contents', 'MacOS')
      if (existsSync(macosDir)) {
        executables.push(...safeReaddir(macosDir).map((name) => join(macosDir, name)))
      }
    }
  }
  return executables
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Second veto beside the pid records: a process whose image is in the tree (a daemon whose record
 * was lost) keeps it. Anything but lsof's clean "no match" counts as in use.
 */
async function anyProcessRunsFrom(executables: string[], mode: HostToolMode): Promise<boolean> {
  if (executables.length === 0) {
    return false
  }
  const result = await runHostTool(
    '/usr/sbin/lsof',
    ['-w', '-t', '--', ...executables],
    LSOF_TIMEOUT_MS,
    mode
  )
  return !(result.code === 1 && result.stdout.trim() === '' && result.stderr.trim() === '')
}

async function reclaimAbandonedStaging(versionDir: string, mode: HostToolMode): Promise<void> {
  for (const name of safeReaddir(versionDir)) {
    if (name.startsWith('.staging-') && stagingWriterVerdict(name).status === 'exited') {
      await removeDarwinDaemonHostTree(join(versionDir, name), mode)
    }
  }
}

/**
 * Reclaim clone dirs of versions that are neither current nor pinned by a live daemon's pid record,
 * and that no running process maps. Best-effort; never throws.
 */
export async function pruneDarwinDaemonHosts(
  evidence: PinnedDaemonVersionsEvidence,
  mode: HostToolMode = {}
): Promise<void> {
  if (!isPackagedElectronDarwin()) {
    return
  }
  const root = getDarwinDaemonHostRootDir()
  const currentVersion = getAppEnvironment().getVersion()
  for (const version of safeReaddir(root)) {
    const versionDir = join(root, version)
    if (mode.signal?.aborted) {
      return
    }
    if (version.startsWith('.')) {
      continue
    }
    await reclaimAbandonedStaging(versionDir, mode)
    if (version === currentVersion) {
      continue
    }
    if (evidence.status === 'unverifiable') {
      reportDaemonHost('kept', `keeping ${versionDir}: ${evidence.reason}`)
      continue
    }
    // A complete pid-record listing with no record for this version proves no daemon owns it.
    if ((evidence.versionLiveness.get(version) ?? { status: 'exited' }).status !== 'exited') {
      continue
    }
    if (await anyProcessRunsFrom(versionExecutables(versionDir), mode)) {
      reportDaemonHost('kept', `keeping ${versionDir}: a process still runs from it`)
      continue
    }
    if (!mode.signal?.aborted && (await removeDarwinDaemonHostTree(versionDir, mode))) {
      reportDaemonHost('reclaimed', `reclaimed ${versionDir}`)
    }
  }
}

async function runDarwinDaemonHostMaintenance(
  runtimeDir: string,
  entryPath: string,
  mode: HostToolMode
): Promise<void> {
  try {
    await pruneDarwinDaemonHosts(collectPinnedDaemonVersions(runtimeDir), mode)
    // Why prepare: the next fresh daemon (e.g. after an adopted old one retires) forks without the copy.
    if (!mode.signal?.aborted && darwinDaemonHostNeedsClone(entryPath)) {
      await materializeDarwinDaemonHost(entryPath, mode)
    }
  } catch (error) {
    reportDaemonHost('failed', 'maintenance failed', error)
  }
}

/**
 * Off the startup path and at background priority: reclaim unpinned clones, then clone this version
 * if it has none yet. Never starts once a quit is under way, and its tools die with the quit.
 */
export function scheduleDarwinDaemonHostMaintenance(
  runtimeDir: string,
  entryPath: string,
  isQuitting: () => boolean = () => false
): void {
  if (!isPackagedElectronDarwin()) {
    return
  }
  const quit = new AbortController()
  const timer = setTimeout(() => {
    if (!isQuitting()) {
      void runDarwinDaemonHostMaintenance(runtimeDir, entryPath, {
        background: true,
        signal: quit.signal
      })
    }
  }, MAINTENANCE_DELAY_MS)
  timer.unref()
  getAppEnvironment().onWillQuit(() => {
    clearTimeout(timer)
    quit.abort()
  })
}
