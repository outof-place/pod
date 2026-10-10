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

/**
 * pod-rootd: claude-acc's one root helper (fans, lid-closed awake, sysctls), a daemonService of
 * Pod.app whose BundleProgram is the payload's pod-rootd. Only Pod's main process can register it
 * (SMAppService resolves the plist in the caller's bundle); pod-rootctl, next to it, drives it.
 */
export const ACC_ROOTD_CTL = 'pod-rootctl'

/** Contents/Library/LaunchDaemons/<appId>.rootd.plist, as the payload ships it. */
export function accRootdServiceName(appId: string): string {
  return `${appId}.rootd.plist`
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

/** What the panel learns in pod-services.json: `at` echoes the request's own. */
export type AccRootdRequestOutcome = {
  at: number
  outcome: 'declined' | 'registered' | 'unavailable'
}

/**
 * Pod's own question before it registers pod-rootd: a request in $STATE, forged or not, gets no
 * further than this dialog. Cancel is the default, so a reflexive Return enables nothing.
 */
export const ACC_ROOTD_CONFIRM_DIALOG = {
  type: 'question',
  message: "Enable claude-acc's root helper?",
  detail:
    'It runs as root to control the fans, keep the Mac awake with the lid closed and apply the root tweaks. macOS then asks an admin to allow it in Login Items.',
  buttons: ['Enable', 'Cancel'],
  defaultId: 1,
  cancelId: 1
} satisfies Electron.MessageBoxOptions

/**
 * Puts back what pod-rootd changed as root (fans auto, sleep, sysctls, shaper, Spotlight list):
 * unregistering only stops the daemon, and a disabled sleep would outlive it.
 */
export function restoreAccRootDefaults(
  run: (spec: ProcessSpec) => Promise<ProcessResult>,
  payloadDir: string
): Promise<ProcessResult> {
  return run({ program: join(payloadDir, ACC_ROOTD_CTL), args: ['restore'], timeoutMs: 60_000 })
}
