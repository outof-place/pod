import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

/**
 * Keeps the claude-acc install on this account in step with the payload inside Pod.app.
 * claude-acc stays its own Python/Swift toolkit under ~/.local/share/claude-acc; Pod only runs the
 * payload's setup.sh (with `--owner pod`) when the payload's VERSION, the owner or the app path
 * differ from `owner.json`, and never otherwise. setup.sh writes owner.json itself, after which
 * Homebrew's claude-acc-setup refuses to overwrite Pod's copy.
 */

export const ACC_STATE_DIR = '.local/share/claude-acc'
const OWNER = 'pod'
const LOCK = 'pod-setup.lock'
// setup.sh builds bytecode, rewrites hooks and restarts launchd jobs: a minute is normal, five is stuck
const SETUP_TIMEOUT_MS = 5 * 60_000
const STALE_LOCK_MS = 10 * 60_000

export type AccOwnerRecord = { owner: string; version: string | null; app: string | null }

export type AccLifecycleDecision =
  | { action: 'skip'; reason: 'not-darwin' | 'no-payload' | 'disabled' }
  | { action: 'up-to-date'; version: string }
  | {
      action: 'install'
      reason: 'first-install' | 'version-changed' | 'owner-changed' | 'app-moved'
      version: string
      from: AccOwnerRecord | null
    }

export type AccLifecycleInput = {
  platform: NodeJS.Platform
  home: string
  /** Contents/Resources/<payload> of the running Pod.app. */
  payloadDir: string
  /** The running Pod.app, recorded in owner.json. */
  appPath: string
  /** `POD_ACC_LIFECYCLE`: unset = install, `dry-run` = decide and report only, `off` = skip. */
  mode?: string
}

export function readPayloadVersion(payloadDir: string): string | null {
  try {
    const version = readFileSync(join(payloadDir, 'VERSION'), 'utf8').trim()
    return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : null
  } catch {
    return null
  }
}

export function readOwnerRecord(home: string): AccOwnerRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, ACC_STATE_DIR, 'owner.json'), 'utf8'))
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const owner = Reflect.get(raw, 'owner')
    const version = Reflect.get(raw, 'version')
    const app = Reflect.get(raw, 'app')
    return typeof owner === 'string'
      ? {
          owner,
          version: typeof version === 'string' ? version : null,
          app: typeof app === 'string' ? app : null
        }
      : null
  } catch {
    return null
  }
}

export function decideAccLifecycle(input: AccLifecycleInput): AccLifecycleDecision {
  if (input.platform !== 'darwin') {
    return { action: 'skip', reason: 'not-darwin' }
  }
  if (input.mode === 'off') {
    return { action: 'skip', reason: 'disabled' }
  }
  const version = readPayloadVersion(input.payloadDir)
  if (!version || !existsSync(join(input.payloadDir, 'setup.sh'))) {
    return { action: 'skip', reason: 'no-payload' }
  }
  const owner = readOwnerRecord(input.home)
  if (!owner) {
    return { action: 'install', reason: 'first-install', version, from: null }
  }
  if (owner.owner !== OWNER) {
    return { action: 'install', reason: 'owner-changed', version, from: owner }
  }
  if (owner.version !== version) {
    return { action: 'install', reason: 'version-changed', version, from: owner }
  }
  if (owner.app !== input.appPath) {
    return { action: 'install', reason: 'app-moved', version, from: owner }
  }
  return { action: 'up-to-date', version }
}

/** setup.sh with the payload's own app and helpers, as Pod's owner. */
export function accSetupSpec(input: AccLifecycleInput): ProcessSpec {
  const p = (name: string): string => join(input.payloadDir, name)
  return {
    program: '/bin/bash',
    args: [
      p('setup.sh'),
      '--app',
      p('Claude Acc.app'),
      '--fanctl',
      p('fanctl'),
      '--hook',
      p('claude-acc-hook'),
      '--desktop',
      p('claude-acc-desktop'),
      '--owner',
      OWNER,
      '--owner-app',
      input.appPath
    ],
    env: {
      HOME: input.home,
      USER: input.home.split('/').pop() ?? '',
      PATH: `${input.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8'
    },
    timeoutMs: SETUP_TIMEOUT_MS
  }
}

export type AccLifecycleOutcome =
  | { status: 'skipped' | 'up-to-date' | 'busy'; decision: AccLifecycleDecision }
  | { status: 'dry-run'; decision: AccLifecycleDecision; spec: ProcessSpec }
  | {
      status: 'installed' | 'failed'
      decision: AccLifecycleDecision
      result: ProcessResult
      message: string
    }

/** O_EXCL lock so two Pod windows or relaunches never run setup.sh twice at once. */
function takeLock(home: string): string | null {
  const dir = join(home, ACC_STATE_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LOCK)
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

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim())
  return lines.findLast(Boolean) ?? ''
}

export async function runAccLifecycle(
  input: AccLifecycleInput,
  run: (spec: ProcessSpec) => Promise<ProcessResult>
): Promise<AccLifecycleOutcome> {
  const decision = decideAccLifecycle(input)
  if (decision.action === 'skip') {
    return { status: 'skipped', decision }
  }
  if (decision.action === 'up-to-date') {
    return { status: 'up-to-date', decision }
  }
  const spec = accSetupSpec(input)
  if (input.mode === 'dry-run') {
    return { status: 'dry-run', decision, spec }
  }
  const lock = takeLock(input.home)
  if (!lock) {
    return { status: 'busy', decision }
  }
  try {
    const result = await run(spec)
    const after = readOwnerRecord(input.home)
    const ok =
      result.code === 0 &&
      after?.owner === OWNER &&
      after.version === decision.version &&
      after.app === input.appPath
    const message = lastLine(`${result.stdout}\n${result.stderr}`)
    return { status: ok ? 'installed' : 'failed', decision, result, message }
  } finally {
    rmSync(lock, { force: true })
  }
}
