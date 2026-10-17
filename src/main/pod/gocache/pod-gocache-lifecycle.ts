import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { failedSetup } from '../acc/acc-lifecycle-record'
import { launchctlSpec } from '../launchd/launchctl-darwin'
import { resolveUserGoCache } from './pod-gocache-go-env'
import {
  helperReplacement,
  isRegularFile,
  readHelperVersion,
  type RunProcess
} from './pod-gocache-helper-binary'
import {
  installHelperAndAgent,
  plistIsCurrent,
  rotateDaemonLog,
  takeInstallLock
} from './pod-gocache-install'
import { isAgentDisabled, readAgentState, serviceTarget } from './pod-gocache-launch-agent'
import { writePodGoCacheLifecycleRecord } from './pod-gocache-lifecycle-record'
import { podGoCacheStateDir } from './pod-gocache-paths'
import { isPodGoCacheOff } from './pod-gocache-switch'

// acc-lifecycle.ts's install rules (own HOME and profile, no harness, no downgrade, lock, backoff) for pod-gocache.
// No owner record like acc's: the helper answers its own version, launchd names the stable copy, owner.json is the daemon's.

export type PodGoCacheSkipReason =
  | 'not-darwin'
  | 'disabled'
  | 'setting-off'
  | 'automated-launch'
  | 'home-override'
  | 'custom-profile'
  | 'no-helper'
  | 'user-disabled'
  | 'no-go-toolchain'
  | 'gocache-off'
  | 'helper-broken'
  | 'installed-unanswered'
  | 'newer-installed'
  | 'install-backoff'

type PodGoCacheInstallReason =
  | 'first-install'
  | 'version-changed'
  | 'installed-broken'
  | 'forced'
  | 'agent-changed'
  | 'agent-missing'
  | 'install-failed'

export type AgentState = 'running' | 'stopped' | 'not-loaded' | null

export type PodGoCacheDecision =
  | { action: 'skip'; reason: PodGoCacheSkipReason }
  | { action: 'up-to-date'; version: string; cacheDir: string; agent: AgentState }
  | {
      action: 'install'
      reason: PodGoCacheInstallReason
      version: string
      /** The installed helper's version, null when there is none or it answers nothing. */
      from: string | null
      /** The user's GOCACHE, which the daemon is started with. */
      cacheDir: string
      replaceHelper: boolean
      /** Installs of this version that failed in a row before this one (pod-lifecycle.json). */
      failedAttempts?: number
    }

export type PodGoCacheLifecycleInput = {
  platform: NodeJS.Platform
  /** HOME of this process: where the helper, its state and the launch agent go. */
  home: string
  /** The account's home from the user database, which a HOME override cannot move. */
  accountHome: string | null
  userDataPath: string
  defaultUserDataPath: string | null
  /** Contents/Resources/bin/pod-gocache of the running app. */
  bundledHelper: string
  /** The process's uid: the agent goes into gui/<uid>. */
  uid: number | null
  /** The running app's bundle id, for Login Items. */
  bundleId: string | null
  /** The running app, recorded in pod-lifecycle.json. */
  appPath?: string
  /** `POD_GOCACHE`: unset = on, `0` or `off` = off, `dry-run` = decide and report only. */
  mode?: string
  /** The podGoCacheEnabled setting (default on). */
  settingEnabled: boolean
  automatedBy?: string | null
  /** The environment a terminal of this user gets (login shell PATH): where their go is found. */
  goEnv: NodeJS.ProcessEnv
  /** dev-install.sh --force: replace the installed helper whatever version it answers. */
  force?: boolean
  now?: number
  /** Between bootstrap attempts; tests pass 0. */
  bootstrapRetryMs?: number
}

export type PodGoCacheLifecycleOutcome =
  | { status: 'skipped' | 'busy' | 'dry-run'; decision: PodGoCacheDecision }
  | { status: 'up-to-date'; decision: PodGoCacheDecision; kickstarted: boolean }
  | { status: 'refused'; decision: PodGoCacheDecision; message: string }
  | {
      status: 'installed' | 'failed'
      decision: PodGoCacheDecision
      message: string
      exit: number | null
      timedOut: boolean
    }

function isAccountHome(input: PodGoCacheLifecycleInput): boolean {
  return input.accountHome !== null && resolve(input.home) === resolve(input.accountHome)
}

function preflightSkip(input: PodGoCacheLifecycleInput): PodGoCacheSkipReason | null {
  if (input.platform !== 'darwin') {
    return 'not-darwin'
  }
  if (isPodGoCacheOff(input.mode)) {
    return 'disabled'
  }
  if (!input.settingEnabled) {
    return 'setting-off'
  }
  if (input.automatedBy) {
    return 'automated-launch'
  }
  if (!isAccountHome(input)) {
    return 'home-override'
  }
  if (
    input.defaultUserDataPath === null ||
    resolve(input.userDataPath) !== resolve(input.defaultUserDataPath)
  ) {
    return 'custom-profile'
  }
  return isRegularFile(input.bundledHelper) ? null : 'no-helper'
}

async function agentState(input: PodGoCacheLifecycleInput, run: RunProcess): Promise<AgentState> {
  if (input.uid === null) {
    return null
  }
  return readAgentState(await run(launchctlSpec(['print', serviceTarget(input.uid)])))
}

/** `launchctl disable` is the user's word on the agent: never re-enabled, never retried. */
async function isDisabledByUser(
  input: PodGoCacheLifecycleInput,
  run: RunProcess
): Promise<boolean> {
  if (input.uid === null) {
    return false
  }
  return isAgentDisabled(await run(launchctlSpec(['print-disabled', `gui/${input.uid}`])))
}

export async function decidePodGoCacheLifecycle(
  input: PodGoCacheLifecycleInput,
  run: RunProcess
): Promise<PodGoCacheDecision> {
  const skip = preflightSkip(input)
  if (skip) {
    return { action: 'skip', reason: skip }
  }
  if (await isDisabledByUser(input, run)) {
    return { action: 'skip', reason: 'user-disabled' }
  }
  const goCache = await resolveUserGoCache(input.goEnv, run)
  if ('skip' in goCache) {
    return { action: 'skip', reason: goCache.skip }
  }
  const version = await readHelperVersion(input.bundledHelper, run)
  if (!version) {
    return { action: 'skip', reason: 'helper-broken' }
  }
  const helper = await helperReplacement(input, version, run)
  if (typeof helper === 'string') {
    return { action: 'skip', reason: helper }
  }
  // an install that failed may have replaced the helper before it stopped
  const failed = failedSetup(podGoCacheStateDir(input.home), version)
  if (failed && (input.now ?? Date.now()) < failed.notBefore) {
    return { action: 'skip', reason: 'install-backoff' }
  }
  const { cacheDir } = goCache
  const plistCurrent = plistIsCurrent(input.home, cacheDir)
  const agent = helper.replace === null && plistCurrent ? await agentState(input, run) : null
  const reason =
    helper.replace ??
    (!plistCurrent ? 'agent-changed' : agent === 'not-loaded' ? 'agent-missing' : null)
  if (reason === null && !failed) {
    return { action: 'up-to-date', version, cacheDir, agent }
  }
  return {
    action: 'install',
    reason: reason ?? 'install-failed',
    version,
    from: helper.from,
    cacheDir,
    replaceHelper: helper.replace !== null,
    ...(failed ? { failedAttempts: failed.attempts } : {})
  }
}

/** Checked right before launchd is touched: only the account's own HOME and gui/<uid>. */
export function installRefusal(input: PodGoCacheLifecycleInput): string | null {
  if (input.accountHome === null) {
    return 'the account home is unknown'
  }
  if (!isAccountHome(input)) {
    return `HOME ${input.home} is not the account home ${input.accountHome}`
  }
  if (input.uid === null) {
    return 'the uid is unknown'
  }
  return null
}

async function install(
  input: PodGoCacheLifecycleInput,
  decision: Extract<PodGoCacheDecision, { action: 'install' }>,
  uid: number,
  run: RunProcess
): Promise<PodGoCacheLifecycleOutcome> {
  try {
    const failure = await installHelperAndAgent(input, decision, uid, run)
    if (failure) {
      return { status: 'failed', decision, ...failure }
    }
    const loaded = await agentState(input, run)
    return loaded === 'running' || loaded === 'stopped'
      ? {
          status: 'installed',
          decision,
          message: `pod-gocache ${decision.version}`,
          exit: 0,
          timedOut: false
        }
      : {
          status: 'failed',
          decision,
          message: 'the agent is not loaded after bootstrap',
          exit: null,
          timedOut: false
        }
  } catch (error) {
    return { status: 'failed', decision, message: String(error), exit: null, timedOut: false }
  }
}

async function act(
  input: PodGoCacheLifecycleInput,
  decision: PodGoCacheDecision,
  run: RunProcess
): Promise<PodGoCacheLifecycleOutcome> {
  if (decision.action === 'skip') {
    return { status: 'skipped', decision }
  }
  if (input.mode === 'dry-run') {
    return { status: 'dry-run', decision }
  }
  const refusal = installRefusal(input)
  const uid = refusal === null ? input.uid : null
  if (decision.action === 'up-to-date') {
    // a daemon that exited stays down until a crash, a login or this: one start per Pod launch
    if (decision.agent !== 'stopped' || uid === null) {
      return { status: 'up-to-date', decision, kickstarted: false }
    }
    rotateDaemonLog(input.home)
    await run(launchctlSpec(['kickstart', serviceTarget(uid)]))
    return { status: 'up-to-date', decision, kickstarted: true }
  }
  if (uid === null) {
    return { status: 'refused', decision, message: refusal ?? 'the uid is unknown' }
  }
  const lock = takeInstallLock(podGoCacheStateDir(input.home))
  if (!lock) {
    return { status: 'busy', decision }
  }
  try {
    // another Pod may have installed while this one decided: never act on a stale decision
    const locked = await decidePodGoCacheLifecycle(input, run)
    return locked.action === 'install'
      ? await install(input, locked, uid, run)
      : await act(input, locked, run)
  } finally {
    rmSync(lock, { force: true })
  }
}

export async function runPodGoCacheLifecycle(
  input: PodGoCacheLifecycleInput,
  run: RunProcess
): Promise<PodGoCacheLifecycleOutcome> {
  const outcome = await act(input, await decidePodGoCacheLifecycle(input, run), run)
  try {
    writePodGoCacheLifecycleRecord(podGoCacheStateDir(input.home), outcome, {
      app: input.appPath ?? '',
      at: new Date(input.now ?? Date.now()),
      pid: process.pid
    })
  } catch {
    // the record only drives the retry backoff and diagnostics
  }
  return outcome
}
