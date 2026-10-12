// Fork-only (Pod): when Pod's entries leave ~/.claude/settings.json. A claude started before Pod's
// hooks came with each launch reads them from that file, and Claude reloads it live, so cutting
// them early would take a running agent's status away. The cut (pod-claude-settings-migration.ts,
// unchanged) waits until no such claude runs: every live claude in a Pod pane that reads this file
// carries POD_CLAUDE_SETTINGS_PID, the launcher's mark. The process table decides, so a Pod
// restarted mid-wait decides the same way; it is read again when a claude starts or exits (the hook
// server's rows, and a kqueue watcher on the waited-for pids), never on a timer.
import { readFileSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import {
  migratePodClaudeSettings,
  removePodClaudeEntries,
  type PodClaudeMigrationEntry
} from './pod-claude-settings-migration'

const PS = '/bin/ps'
const PS_TIMEOUT_MS = 3000

type Names = { hookScript: string; statusLineScript: string }
type Run = typeof runProcess

/** Claudes in Pod panes under `home` that got no launch settings; null when the process table
 *  can't be read (the cut then waits). An account profile's claude counts too: its settings.json is
 *  a copy of this one, refreshed after the cut. */
export async function scanLegacyClaudes(
  home: string,
  run: Run = runProcess
): Promise<number[] | null> {
  const list = await run({
    program: PS,
    args: ['-Ao', 'pid=,comm='],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024
  })
  if (list.timedOut || list.code !== 0) {
    return null
  }
  const pids: number[] = []
  for (const line of list.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match && match[2].split('/').at(-1) === 'claude' && Number(match[1]) !== process.pid) {
      pids.push(Number(match[1]))
    }
  }
  if (pids.length === 0) {
    return []
  }
  // Why -E: the environment after the arguments (KERN_PROCARGS2); ps exits 1 for a pid gone meanwhile.
  const described = await run({
    program: PS,
    args: ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024 * 1024
  })
  if (described.timedOut) {
    return null
  }
  const legacy: number[] = []
  for (const line of described.stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const text = ` ${match[2]} `
    if (
      text.includes(' ORCA_PANE_KEY=') &&
      text.includes(` HOME=${home} `) &&
      !text.includes(' POD_CLAUDE_SETTINGS_PID=')
    ) {
      legacy.push(Number(match[1]))
    }
  }
  return legacy
}

/** The launcher's watcher: settles once one of `pids` exits; `cancel` stops it. */
export function launcherAwaitExit(
  launcher: string,
  pids: number[],
  run: Run = runProcess
): { exited: Promise<void>; cancel: () => void } {
  const controller = new AbortController()
  const exited = run({
    program: launcher,
    args: ['--await-exit', ...pids.map(String)],
    timeoutMs: null,
    signal: controller.signal
  }).then(
    () => undefined,
    () => undefined
  )
  return { exited, cancel: () => controller.abort() }
}

export type PodClaudeSettingsCutOptions = {
  settingsPath: () => string
  agentHooksDir: () => string
  names: () => Names
  scan: () => Promise<number[] | null>
  /** Null where nothing may outlive the call (the CLI): the next start or event decides. */
  awaitExit: ((pids: number[]) => { exited: Promise<void>; cancel: () => void }) | null
  log?: (event: string, details?: Record<string, unknown>) => void
}

export class PodClaudeSettingsCut {
  private armed = false
  private running: Promise<void> | null = null
  private again = false
  private watcher: { key: string; cancel: () => void } | null = null

  constructor(private readonly options: PodClaudeSettingsCutOptions) {}

  get pending(): boolean {
    return this.armed
  }

  /** Settles once a running check has. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  /** At install: Pod's entries still in settings.json arm the cut, and it is tried at once. */
  arm(): Promise<void> {
    this.armed = this.hasPodEntries()
    return this.recheck()
  }

  /** Pod's hooks went back into settings.json (an older Claude): nothing to wait for. */
  disarm(): void {
    this.armed = false
    this.stopWatching()
  }

  /** A claude started or exited (the hook server's rows). */
  noteAgentChange(): void {
    if (this.armed) {
      void this.recheck()
    }
  }

  recheck(): Promise<void> {
    if (!this.armed) {
      return Promise.resolve()
    }
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.checkOnce()
      } while (this.again && this.armed)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private hasPodEntries(): boolean {
    try {
      const text = readFileSync(this.options.settingsPath(), 'utf8')
      return (removePodClaudeEntries(text, this.options.names())?.removed.length ?? 0) > 0
    } catch {
      return false
    }
  }

  private async checkOnce(): Promise<void> {
    if (!this.hasPodEntries()) {
      this.disarm()
      return
    }
    const legacy = await this.options.scan()
    if (legacy === null) {
      this.options.log?.('pod-claude-settings-cut-waits', { reason: 'process table unreadable' })
      return
    }
    if (legacy.length > 0) {
      this.watch(legacy)
      return
    }
    this.stopWatching()
    let entry: PodClaudeMigrationEntry | null = null
    try {
      entry = migratePodClaudeSettings(
        this.options.settingsPath(),
        this.options.agentHooksDir(),
        this.options.names()
      )
    } catch (error) {
      this.options.log?.('pod-claude-settings-cut-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }
    this.armed = false
    this.options.log?.('pod-claude-settings-cut', { removed: entry?.removed.length ?? 0 })
  }

  private watch(pids: number[]): void {
    const key = [...pids].sort((a, b) => a - b).join(',')
    this.options.log?.('pod-claude-settings-cut-waits', { legacyClaudes: pids.length })
    if (!this.options.awaitExit || this.watcher?.key === key) {
      return
    }
    this.stopWatching()
    const watcher = this.options.awaitExit(pids)
    this.watcher = { key, cancel: watcher.cancel }
    void watcher.exited.then(() => {
      if (this.watcher?.key === key) {
        this.watcher = null
        void this.recheck()
      }
    })
  }

  private stopWatching(): void {
    this.watcher?.cancel()
    this.watcher = null
  }
}
