import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { ACC_STATE_DIR } from './acc-lifecycle'
import type { AccServiceStatus } from './acc-services'

/**
 * pod-rootd: claude-acc's one root helper (fans, lid-closed awake, sysctls). The user installs it
 * from the signed pod-rootd.pkg next to pod-rootctl in the payload: Installer checks the package and
 * asks an administrator, and it lands in /Library as a launchd job Login Items lists under Pod. Pod
 * registers nothing and sends it nothing (docs/pod-rootd.md in claude-acc): it asks pod-rootctl
 * where the helper stands and opens the package or Login Items on the user's yes.
 */
export const ACC_ROOTD_CTL = 'pod-rootctl'
export const ACC_ROOTD_PACKAGE = 'pod-rootd.pkg'

/** /Library/LaunchDaemons/<appId>.rootd.plist, as the package installs it. */
export function accRootdServiceName(appId: string): string {
  return `${appId}.rootd.plist`
}

/** What the user does next (`pod-rootctl service status`): install it, switch it on, or nothing. */
export type AccRootdStep = 'install' | 'approve' | 'ready'
const STEPS: readonly AccRootdStep[] = ['install', 'approve', 'ready']

/** pod-services.json's daemons entry keeps SMAppService's words, which AccKit's panel reads. */
export const ACC_ROOTD_STEP_STATUS = {
  install: 'not-registered',
  approve: 'requires-approval',
  ready: 'enabled'
} as const satisfies Record<AccRootdStep, AccServiceStatus>

type Run = (spec: ProcessSpec) => Promise<ProcessResult>

/** null when pod-rootctl can't say (missing, killed, an answer from a newer one). */
export async function readAccRootdStep(run: Run, payloadDir: string): Promise<AccRootdStep | null> {
  const result = await run({
    program: join(payloadDir, ACC_ROOTD_CTL),
    args: ['service', 'status', '--json'],
    timeoutMs: 10_000
  }).catch(() => null)
  if (result?.code !== 0) {
    return null
  }
  try {
    const body: unknown = JSON.parse(result.stdout)
    const step = typeof body === 'object' && body !== null && 'step' in body ? body.step : null
    return STEPS.find((known) => known === step) ?? null
  } catch {
    return null
  }
}

/**
 * $STATE/pod-rootd-request.json: the user pressed "Enable root helper…" in AccServicesView (AccKit's
 * AccCommands.requestRootHelper). Pod offers no URL or other entry point for it: a web page or
 * another account can't start a root registration.
 */
export const ACC_ROOTD_REQUEST = 'pod-rootd-request.json'
const REQUEST_MAX_AGE_MS = 5 * 60_000
// the panel's clock and Pod's are the same Mac's: a request from the future is forged or broken
const REQUEST_MAX_SKEW_MS = 60_000

export type AccRootdRequest = { ok: true; at: number } | { ok: false; reason: string }

/**
 * Takes a pending request, valid or not (null when there is none). It counts only as a regular
 * file of this uid that no one else can write, saying enable, from the last few minutes.
 */
export function takeAccRootdRequest(
  home: string,
  now: Date,
  uid = process.getuid?.()
): AccRootdRequest | null {
  const path = join(home, ACC_STATE_DIR, ACC_ROOTD_REQUEST)
  const taken = `${path}.taken`
  try {
    renameSync(path, taken)
  } catch {
    return null
  }
  let fd: number | null = null
  try {
    try {
      fd = openSync(taken, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return { ok: false, reason: 'not a regular file' }
    }
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid) {
      return { ok: false, reason: "not a regular file of this account's" }
    }
    if ((stat.mode & 0o022) !== 0 || stat.size > 4096) {
      return { ok: false, reason: 'writable by others or too large' }
    }
    let body: unknown
    try {
      body = JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      return { ok: false, reason: 'not JSON' }
    }
    if (typeof body !== 'object' || body === null || !('action' in body) || !('at' in body)) {
      return { ok: false, reason: 'not an enable request' }
    }
    if (body.action !== 'enable' || typeof body.at !== 'number') {
      return { ok: false, reason: 'not an enable request' }
    }
    const age = now.getTime() - body.at * 1000
    if (age > REQUEST_MAX_AGE_MS || age < -REQUEST_MAX_SKEW_MS) {
      return { ok: false, reason: age > 0 ? 'stale' : 'from the future' }
    }
    return { ok: true, at: body.at }
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
    rmSync(taken, { force: true })
  }
}

/**
 * What the panel learns in pod-services.json: `at` echoes the request's own. `outcome` keeps the
 * words AccKit 0.4 to 0.8 decode (an unknown one drops the whole answer): registered means Pod
 * passed the yes on, to Installer or Login Items, or found the helper ready; `step` says which.
 */
export type AccRootdRequestOutcome = {
  at: number
  outcome: 'declined' | 'registered' | 'unavailable'
  step?: AccRootdStep
}

/**
 * Pod's own question before it opens Installer or Login Items: a request in $STATE, forged or not,
 * gets no further than this dialog. Cancel is the default, so a reflexive Return opens nothing.
 */
export function accRootdConfirmDialog(step: 'install' | 'approve'): Electron.MessageBoxOptions {
  return {
    type: 'question',
    message: "Enable claude-acc's root helper?",
    detail: `It runs as root to control the fans, keep the Mac awake with the lid closed and apply the root tweaks. ${
      step === 'install'
        ? 'Pod opens its signed installer package, and Installer asks an administrator.'
        : 'It is installed but switched off: Pod opens Login Items in System Settings.'
    }`,
    buttons: [step === 'install' ? 'Open Installer' : 'Open Login Items', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  }
}

export type AccRootdAnswerTools = {
  run: Run
  payloadDir: string
  confirm?: (step: 'install' | 'approve') => Promise<boolean>
  /** Electron's shell.openPath: '' once opened, else why not. */
  openPath?: (path: string) => Promise<string>
}

/** Answers a taken request: nothing to do once ready, else Pod's dialog, then Installer or Login Items. */
export async function answerAccRootdRequest(
  tools: AccRootdAnswerTools
): Promise<Omit<AccRootdRequestOutcome, 'at'>> {
  const step = await readAccRootdStep(tools.run, tools.payloadDir)
  if (step === null) {
    return { outcome: 'unavailable' }
  }
  if (step === 'ready') {
    return { outcome: 'registered', step }
  }
  if (!((await tools.confirm?.(step).catch(() => false)) ?? false)) {
    return { outcome: 'declined', step }
  }
  if (step === 'approve') {
    const opened = await tools
      .run({
        program: join(tools.payloadDir, ACC_ROOTD_CTL),
        args: ['service', 'open-settings'],
        timeoutMs: 10_000
      })
      .catch(() => null)
    return { outcome: opened?.code === 0 ? 'registered' : 'unavailable', step }
  }
  const error = tools.openPath
    ? await tools.openPath(join(tools.payloadDir, ACC_ROOTD_PACKAGE)).catch(String)
    : 'no way to open it'
  return { outcome: error === '' ? 'registered' : 'unavailable', step }
}
