import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'

/**
 * Keeps the claude-acc install on this account in step with the payload inside Pod.app.
 * claude-acc stays its own Python/Swift toolkit under ~/.local/share/claude-acc; Pod only runs the
 * payload's setup.sh (with `--owner pod`) when the payload's VERSION, the owner or the app path
 * differ from `owner.json`, and never otherwise. setup.sh writes owner.json itself, after which
 * Homebrew's claude-acc-setup refuses to overwrite Pod's copy.
 */

export const ACC_STATE_DIR = '.local/share/claude-acc'
/** The menu helper of a v2 payload, run from Contents/Library/LoginItems as an SMAppService login item. */
export const ACC_MENU_HELPER_APP = 'Pod Menu.app'
const OWNER = 'pod'
const LOCK = 'pod-setup.lock'
// setup.sh builds bytecode, rewrites hooks and restarts launchd jobs: a minute is normal, five is stuck
const SETUP_TIMEOUT_MS = 5 * 60_000
// setup.sh refusing before it touches anything: another owner holds claude-acc (owner.py), or HOME
// is not the account's home. Final for this launch, never a failed install to retry.
const SETUP_REFUSALS: Record<number, string> = {
  3: 'claude-acc belongs to another owner',
  4: 'HOME is not the account home'
}
const STALE_LOCK_MS = 10 * 60_000

export type AccOwnerRecord = { owner: string; version: string | null; app: string | null }

// Harness launches (E2E, bench, background) run with a throwaway HOME or profile, and setup.sh
// re-points the account's real launchd jobs (gui/<uid>) at whatever HOME it gets.
// Both prefixes: Pod's decouple codemod renames ORCA_* to POD_* in its own runtime and harness.
export const AUTOMATED_LAUNCH_ENV = [
  'ORCA_E2E_USER_DATA_DIR',
  'ORCA_E2E_HEADLESS',
  'ORCA_BACKGROUND_LAUNCH',
  'POD_E2E_USER_DATA_DIR',
  'POD_E2E_HEADLESS',
  'POD_BACKGROUND_LAUNCH'
] as const

/** The first harness variable set in `env`, or null for a launch by the user. */
export function automatedLaunchEnv(env: NodeJS.ProcessEnv): string | null {
  return AUTOMATED_LAUNCH_ENV.find((name) => Boolean(env[name])) ?? null
}

export type AccLifecycleSkipReason =
  | 'not-darwin'
  | 'no-payload'
  | 'disabled'
  | 'automated-launch'
  | 'home-override'
  | 'custom-profile'
  | 'handed-back'

export type AccLifecycleDecision =
  | { action: 'skip'; reason: AccLifecycleSkipReason }
  | { action: 'up-to-date'; version: string }
  | {
      action: 'install'
      reason: 'first-install' | 'version-changed' | 'app-moved'
      version: string
      from: AccOwnerRecord | null
    }

export type AccLifecycleInput = {
  platform: NodeJS.Platform
  /** HOME of this process: where owner.json is read. */
  home: string
  /** The account's home from the user database (getpwuid), which a HOME override cannot move. */
  accountHome: string | null
  /** This Pod's profile, and the product's default one: only the default profile installs. */
  userDataPath: string
  defaultUserDataPath: string | null
  /** Contents/Resources/<payload> of the running Pod.app. */
  payloadDir: string
  /** The running Pod.app, recorded in owner.json. */
  appPath: string
  /** `POD_ACC_LIFECYCLE`: unset = install, `dry-run` = decide and report only, `off` or `0` = skip. */
  mode?: string
  /** From automatedLaunchEnv: the harness variable that launched this Pod. */
  automatedBy?: string | null
}

function isOff(mode: string | undefined): boolean {
  return mode === 'off' || mode === '0'
}

/** Whether HOME is the account's own home, so setup.sh's launchctl calls target the right files. */
function isAccountHome(input: AccLifecycleInput): boolean {
  return input.accountHome !== null && resolve(input.home) === resolve(input.accountHome)
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
  if (isOff(input.mode)) {
    return { action: 'skip', reason: 'disabled' }
  }
  if (input.automatedBy) {
    return { action: 'skip', reason: 'automated-launch' }
  }
  if (!isAccountHome(input)) {
    return { action: 'skip', reason: 'home-override' }
  }
  if (
    input.defaultUserDataPath === null ||
    resolve(input.userDataPath) !== resolve(input.defaultUserDataPath)
  ) {
    return { action: 'skip', reason: 'custom-profile' }
  }
  const version = readPayloadVersion(input.payloadDir)
  if (!version || !existsSync(join(input.payloadDir, 'setup.sh'))) {
    return { action: 'skip', reason: 'no-payload' }
  }
  const owner = readOwnerRecord(input.home)
  if (!owner) {
    return { action: 'install', reason: 'first-install', version, from: null }
  }
  // Handed back (`claude-acc handback`) or uninstalled: the account chose against Pod's copy, so
  // Pod never takes claude-acc over again and its own services go (the supervisor removes them).
  if (owner.owner !== OWNER) {
    return { action: 'skip', reason: 'handed-back' }
  }
  if (owner.version !== version) {
    return { action: 'install', reason: 'version-changed', version, from: owner }
  }
  if (owner.app !== input.appPath) {
    return { action: 'install', reason: 'app-moved', version, from: owner }
  }
  return { action: 'up-to-date', version }
}

/** A v2 payload ships pod-acc-run: Pod runs its jobs as SMAppService agents, with Pod's Python. */
export function isPodAgentsPayload(payloadDir: string): boolean {
  return existsSync(join(payloadDir, 'pod-acc-run'))
}

/**
 * The payload's menu helper for setup.sh without --pod-agents: from 1.31 it ships as Pod Menu.app
 * (the same ClaudeAcc, bundle id com.filip.claude-acc.menubar), which that path still installs as
 * ~/Applications/Claude Acc.app; earlier payloads ship Claude Acc.app itself.
 */
export function accMenuHelperSource(payloadDir: string): string {
  const podMenu = join(payloadDir, ACC_MENU_HELPER_APP)
  return existsSync(podMenu) ? podMenu : join(payloadDir, 'Claude Acc.app')
}

/** setup.sh with the payload's own app and helpers, as Pod's owner. */
export function accSetupSpec(input: AccLifecycleInput): ProcessSpec {
  const p = (name: string): string => join(input.payloadDir, name)
  const contents = join(input.appPath, 'Contents')
  const podAgents = isPodAgentsPayload(input.payloadDir)
  const python = join(contents, 'Resources', 'python', 'bin', 'python3')
  // v2: setup.sh leaves launchd to Pod's services, and links $STATE/python to Pod's interpreter
  const v2Args = podAgents
    ? ['--pod-agents', ...(existsSync(python) ? ['--python', python] : [])]
    : []
  return {
    program: '/bin/bash',
    args: [
      p('setup.sh'),
      '--app',
      podAgents
        ? join(contents, 'Library', 'LoginItems', ACC_MENU_HELPER_APP)
        : accMenuHelperSource(input.payloadDir),
      '--fanctl',
      p('fanctl'),
      '--hook',
      p('claude-acc-hook'),
      '--desktop',
      p('claude-acc-desktop'),
      '--owner',
      OWNER,
      '--owner-app',
      input.appPath,
      ...v2Args
    ],
    env: {
      HOME: input.home,
      USER: input.home.split('/').pop() ?? '',
      PATH: `${input.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      // setup.sh and its children run Python on the payload's own files: a __pycache__ written
      // next to them is a file added to Pod.app's sealed resources, and Gatekeeper then calls the
      // app damaged. Python under -I ignores this, so claude-acc gives those runs -B itself.
      PYTHONDONTWRITEBYTECODE: '1'
    },
    timeoutMs: SETUP_TIMEOUT_MS
  }
}

/**
 * Checked at the spawn itself, behind decideAccLifecycle: setup.sh runs launchctl bootout/bootstrap
 * in the account's gui/<uid> domain, so it may only ever see the account's own HOME.
 */
export function setupHomeRefusal(input: AccLifecycleInput, spec: ProcessSpec): string | null {
  const specHome = spec.env?.HOME
  if (input.accountHome === null) {
    return 'the account home is unknown'
  }
  if (!isAccountHome(input) || !specHome || resolve(specHome) !== resolve(input.accountHome)) {
    return `HOME ${specHome ?? '(unset)'} is not the account home ${input.accountHome}`
  }
  return null
}

export type AccLifecycleOutcome =
  | { status: 'skipped' | 'up-to-date' | 'busy'; decision: AccLifecycleDecision }
  | { status: 'refused'; decision: AccLifecycleDecision; message: string }
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
  const refusal = setupHomeRefusal(input, spec)
  if (refusal) {
    return { status: 'refused', decision, message: refusal }
  }
  const lock = takeLock(input.home)
  if (!lock) {
    return { status: 'busy', decision }
  }
  try {
    const result = await run(spec)
    const refused = result.code === null ? undefined : SETUP_REFUSALS[result.code]
    if (refused) {
      return {
        status: 'refused',
        decision,
        message: `setup.sh exit ${result.code}: ${refused} (${lastLine(`${result.stdout}\n${result.stderr}`)})`
      }
    }
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
