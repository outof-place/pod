// Fork-only (Pod): Settings' Claude accounts are claude-acc's own. Listing reads the account
// tick's status.json; add, sign in again and switch run `claude-acc` (accswitch) itself.
import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '@orca/process-host'
import type {
  PodClaudeAccAccount,
  PodClaudeAccResult,
  PodClaudeAccState,
  PodClaudeAccWindow
} from '../../../shared/pod-claude-acc-accounts'
import { ACC_STATE_DIR } from './acc-lifecycle'

export type ClaudeAccPaths = { home: string; state: string; python: string; launcher: string }

export function claudeAccPaths(home = homedir()): ClaudeAccPaths {
  const state = join(home, ACC_STATE_DIR)
  return { home, state, python: join(state, 'python'), launcher: join(state, 'acc.py') }
}

const EMPTY: PodClaudeAccState = { available: false, generatedAt: null, accounts: [] }
// Why: `switch --auto` and other flags are commands too; only an address reaches accswitch.
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+$/
// accswitch gives the browser 600 s, then cleans up itself.
const SIGN_IN_TIMEOUT_MS = 11 * 60_000
const MAX_OUTPUT_CHARS = 64_000

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function usageWindow(value: unknown): PodClaudeAccWindow | null {
  const window = record(value)
  return window ? { used: finite(window.used), resetsAt: finite(window.resets_at) } : null
}

/** status.json or `status --json` as Settings' rows; null when it isn't claude-acc's snapshot. */
export function parseClaudeAccSnapshot(value: unknown): PodClaudeAccState | null {
  const snapshot = record(value)
  if (!snapshot || !Array.isArray(snapshot.accounts)) {
    return null
  }
  const accounts: PodClaudeAccAccount[] = []
  for (const item of snapshot.accounts) {
    const row = record(item)
    if (!row || typeof row.email !== 'string' || !row.email) {
      continue
    }
    accounts.push({
      email: row.email,
      active: row.active === true,
      usable: row.usable === true,
      needsSignIn: row.status === 'needs_login',
      podProfile: row.source === 'profile',
      note: typeof row.note === 'string' && row.note ? row.note : null,
      session: usageWindow(row.session),
      weekly: usageWindow(row.weekly)
    })
  }
  return { available: true, generatedAt: finite(snapshot.generated_at), accounts }
}

/** The script's last line, without the CLI's "błąd: " prefix. */
export function claudeAccMessage(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines.at(-1) ?? ''
  return last.replace(/^(błąd|error): /, '')
}

type Spawn = typeof spawnProcess
type Run = typeof runProcess

export class PodClaudeAccAccounts {
  private signIn: ChildProcess | null = null
  private cancelled = false

  constructor(
    private readonly paths: ClaudeAccPaths = claudeAccPaths(),
    private readonly spawn: Spawn = spawnProcess,
    private readonly run: Run = runProcess
  ) {}

  async list(): Promise<PodClaudeAccState> {
    try {
      const text = await readFile(join(this.paths.state, 'status.json'), 'utf8')
      return parseClaudeAccSnapshot(JSON.parse(text)) ?? EMPTY
    } catch {
      return EMPTY
    }
  }

  add(): Promise<PodClaudeAccResult> {
    return this.signInFlow(['add'])
  }

  signInAgain(email: string): Promise<PodClaudeAccResult> {
    return EMAIL.test(email) ? this.signInFlow(['login', email]) : this.refused(email)
  }

  async switchTo(email: string): Promise<PodClaudeAccResult> {
    if (!EMAIL.test(email)) {
      return this.refused(email)
    }
    const result = await this.run({
      program: await this.interpreter(),
      args: [this.paths.launcher, 'accswitch', 'switch', email],
      env: this.env(),
      timeoutMs: 90_000,
      maxOutputBytes: MAX_OUTPUT_CHARS
    })
    return this.finish(result.code === 0, claudeAccMessage(result.stdout, result.stderr), false)
  }

  /** SIGTERM only: back from the browser accswitch ignores it and finishes saving. */
  cancel(): boolean {
    if (!this.signIn) {
      return false
    }
    this.cancelled = true
    this.signIn.kill('SIGTERM')
    return true
  }

  private async signInFlow(args: string[]): Promise<PodClaudeAccResult> {
    if (this.signIn) {
      return this.finish(
        false,
        'A Claude sign-in is still open. Finish it in the browser or cancel it.',
        false
      )
    }
    this.cancelled = false
    const child = this.spawn({
      program: await this.interpreter(),
      args: [this.paths.launcher, 'accswitch', ...args],
      env: this.env(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.signIn = child
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), SIGN_IN_TIMEOUT_MS)
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        stderr += `\n${error.message}`
        resolve(null)
      })
      child.once('close', (exitCode) => resolve(exitCode))
    })
    clearTimeout(timer)
    this.signIn = null
    const cancelled = this.cancelled && code !== 0
    return this.finish(code === 0, claudeAccMessage(stdout, stderr), cancelled)
  }

  // Why `status --json` after a change: the tick's file catches up only within 2 minutes.
  private async finish(
    ok: boolean,
    message: string,
    cancelled: boolean
  ): Promise<PodClaudeAccResult> {
    return {
      ok,
      message,
      cancelled,
      state: (ok ? await this.fresh() : null) ?? (await this.list())
    }
  }

  private async fresh(): Promise<PodClaudeAccState | null> {
    try {
      const result = await this.run({
        program: await this.interpreter(),
        args: [this.paths.launcher, 'accswitch', 'status', '--json'],
        env: this.env(),
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024
      })
      return result.code === 0 ? parseClaudeAccSnapshot(JSON.parse(result.stdout)) : null
    } catch {
      return null
    }
  }

  private async refused(email: string): Promise<PodClaudeAccResult> {
    return this.finish(false, `Not an account address: ${email}`, false)
  }

  private async interpreter(): Promise<string> {
    try {
      await access(this.paths.python, constants.X_OK)
      return this.paths.python
    } catch {
      return '/usr/bin/python3'
    }
  }

  // Why HOME, USER and PATH: the scripts need the Keychain account and a PATH that finds `claude`.
  private env(): NodeJS.ProcessEnv {
    const home = this.paths.home
    return {
      ...process.env,
      HOME: home,
      USER: userInfo().username,
      PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    }
  }
}
