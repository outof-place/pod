import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchctlSpec, rotateLaunchdJobLog } from '../launchd/launchctl-darwin'
import { installHelperAtomically, type RunProcess } from './pod-gocache-helper-binary'
import {
  TEARDOWN_WAIT_MS,
  bootoutSpec,
  isBootoutDone,
  podGoCacheDaemonArgs,
  podGoCacheLaunchAgentPlist,
  readAgentState,
  readPlistProgramArguments,
  serviceTarget
} from './pod-gocache-launch-agent'
// types only: the lifecycle imports this module
import type { PodGoCacheDecision, PodGoCacheLifecycleInput } from './pod-gocache-lifecycle'
import {
  podGoCacheDaemonLogPath,
  podGoCacheHelperPath,
  podGoCacheLaunchAgentPath
} from './pod-gocache-paths'

// The install's file and launchd steps; pod-gocache-lifecycle.ts decides when they run.

const LOCK = 'pod-install.lock'
const STALE_LOCK_MS = 10 * 60_000
// A last resort: the teardown wait already saw the old job gone.
const BOOTSTRAP_ATTEMPTS = 3
const TEARDOWN_POLL_MS = 250

type AgentInput = Pick<PodGoCacheLifecycleInput, 'home' | 'bundleId'>
type LaunchdInput = Pick<PodGoCacheLifecycleInput, 'bootstrapRetryMs' | 'teardownPollMs'>

/** Only the daemon's command line counts: another Pod's bundle id or plist template never flips it. */
export function plistIsCurrent(home: string, cacheDir: string): boolean {
  try {
    const args = readPlistProgramArguments(readFileSync(podGoCacheLaunchAgentPath(home), 'utf8'))
    return args?.join('\0') === podGoCacheDaemonArgs(home, cacheDir).join('\0')
  } catch {
    return false
  }
}

/** O_EXCL lock so two Pod windows or relaunches never install at once. */
export function takeInstallLock(stateDir: string): string | null {
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, LOCK)
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return path
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
        rmSync(path, { force: true })
        writeFileSync(path, String(process.pid), { flag: 'wx' })
        return path
      }
    } catch {
      // another process holds it
    }
    return null
  }
}

export function rotateDaemonLog(home: string): void {
  rotateLaunchdJobLog(podGoCacheDaemonLogPath(home))
}

function writePlist(input: AgentInput, cacheDir: string): void {
  const path = podGoCacheLaunchAgentPath(input.home)
  const text = podGoCacheLaunchAgentPlist(input.home, input.bundleId, cacheDir)
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode: 0o644 })
  renameSync(temporary, path)
}

type Step = { message: string; exit: number | null; timedOut: boolean }

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** bootout, then until `launchctl print` says the job is gone: bootstrap fails while launchd still lists it. */
async function bootoutAndWait(
  input: LaunchdInput,
  uid: number,
  run: RunProcess
): Promise<Step | null> {
  const bootout = await run(bootoutSpec(uid))
  if (!isBootoutDone(bootout)) {
    return {
      message: `launchctl bootout: ${bootout.stderr.trim()}`,
      exit: bootout.code,
      timedOut: bootout.timedOut
    }
  }
  const deadline = Date.now() + TEARDOWN_WAIT_MS
  for (;;) {
    const print = await run(launchctlSpec(['print', serviceTarget(uid)]))
    if (readAgentState(print) === 'not-loaded') {
      return null
    }
    if (Date.now() >= deadline) {
      return {
        message: `launchctl bootout: ${serviceTarget(uid)} still loaded ${TEARDOWN_WAIT_MS / 1000} s later`,
        exit: bootout.code,
        timedOut: true
      }
    }
    await sleep(input.teardownPollMs ?? TEARDOWN_POLL_MS)
  }
}

async function loadAgent(
  input: Pick<PodGoCacheLifecycleInput, 'home'> & LaunchdInput,
  uid: number,
  run: RunProcess
): Promise<Step | null> {
  const teardown = await bootoutAndWait(input, uid, run)
  if (teardown) {
    return teardown
  }
  const plist = podGoCacheLaunchAgentPath(input.home)
  let last: Step | null = null
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    const bootstrap = await run(launchctlSpec(['bootstrap', `gui/${uid}`, plist]))
    if (bootstrap.code === 0) {
      return null
    }
    last = {
      message: `launchctl bootstrap: ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`,
      exit: bootstrap.code,
      timedOut: bootstrap.timedOut
    }
    if (attempt < BOOTSTRAP_ATTEMPTS) {
      await sleep(input.bootstrapRetryMs ?? 1000)
    }
  }
  return last
}

/**
 * The agent goes and stays gone: bootout, and the plist deleted even when bootout failed, so the
 * next login never loads it. The helper stays: open terminals may name it in GOCACHEPROG.
 */
export async function removeAgent(
  input: Pick<PodGoCacheLifecycleInput, 'home'> & LaunchdInput,
  uid: number,
  run: RunProcess
): Promise<Step | null> {
  const teardown = await bootoutAndWait(input, uid, run)
  rmSync(podGoCacheLaunchAgentPath(input.home), { force: true })
  return teardown
}

/** Helper (when replaced), plist (with a new helper, or when its command line differs), then bootout and bootstrap. */
export async function installHelperAndAgent(
  input: PodGoCacheLifecycleInput,
  decision: Extract<PodGoCacheDecision, { action: 'install' }>,
  uid: number,
  run: RunProcess
): Promise<Step | null> {
  if (decision.replaceHelper) {
    const failure = await installHelperAtomically(
      input.bundledHelper,
      podGoCacheHelperPath(input.home),
      decision.version,
      run
    )
    if (failure) {
      return { message: failure, exit: null, timedOut: false }
    }
  }
  // the Pod that installs a helper version owns the plist until the next one
  if (decision.replaceHelper || !plistIsCurrent(input.home, decision.cacheDir)) {
    writePlist(input, decision.cacheDir)
  }
  rotateDaemonLog(input.home)
  return loadAgent(input, uid, run)
}
