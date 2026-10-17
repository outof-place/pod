// Fork-only (Pod): what the pool asks of the process table: a pid's start (holder and runtime
// liveness, claude-acc's pid plus start rule) and every process with its argv (outside use of a
// device, simulators booted elsewhere).
//
// A start is the kernel's, in epoch seconds, read the same way by every runtime: `ps` under
// TZ=UTC0 and the English locale, its `lstart` read as UTC. A local-time reading moves with the
// zone each side runs in and is ambiguous in the hour a DST change repeats, so a live runtime could
// read as dead to its peer. The proc-info addon prints local time only, so it serves the table.
import type { NativeProcessInfo } from '../../../../shared/native-process-info'
import { psLocaleEnvironment } from '../../../../shared/ps-locale-environment'
import { simRunProcess, type SimRun } from './sim-command-run'

export type SimProcessRow = Readonly<{ pid: number; ppid: number; command: string }>
export type SimProcessStart = { found: true; startedAt: number } | { found: false } | 'unknown'
export type SimProcessFacts = Readonly<{
  startOf(pid: number): Promise<SimProcessStart>
  // null: the table could not be read.
  table(): Promise<readonly SimProcessRow[] | null>
}>

export type SimNativeProcesses = Pick<NativeProcessInfo, 'listProcessesWithCommands'>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LSTART = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/

/** `ps -o lstart=` printed under TZ=UTC0 (`Sat Oct 17 03:32:53 2026`), as epoch seconds. */
function utcSeconds(lstart: string): number | null {
  const match = LSTART.exec(lstart.trim())
  const month = match ? MONTHS.indexOf(match[1]) : -1
  if (!match || month < 0) {
    return null
  }
  const [, , day, hours, minutes, seconds, year] = match.map(Number)
  return Date.UTC(year, month, day, hours, minutes, seconds) / 1000
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s(.*)$/

export function createSimProcessFacts(
  options: { run?: SimRun; native?: SimNativeProcesses | null; env?: NodeJS.ProcessEnv } = {}
): SimProcessFacts {
  const run = options.run ?? simRunProcess
  const native = options.native ?? null
  const env = psLocaleEnvironment(options.env ?? process.env)
  const utcEnv = { ...env, TZ: 'UTC0' }
  return {
    async startOf(pid) {
      const result = await run('/bin/ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
        timeoutMs: 3_000,
        env: utcEnv
      })
      if (!result.ok) {
        return 'unknown'
      }
      const line = result.stdout.trim()
      if (!line) {
        // Only this is "runs nothing": ps exits 1 and says nothing. Any other failure is not news.
        return result.code === 1 && !result.stderr.trim() ? { found: false } : 'unknown'
      }
      const [stat, ...lstart] = line.split(/\s+/)
      if (result.code !== 0) {
        return 'unknown'
      }
      if (stat.startsWith('Z')) {
        return { found: false }
      }
      const startedAt = utcSeconds(lstart.join(' '))
      return startedAt === null ? 'unknown' : { found: true, startedAt }
    },

    async table() {
      if (native) {
        try {
          const rows = await native.listProcessesWithCommands()
          return rows.map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command ?? '' }))
        } catch {
          return null
        }
      }
      const result = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
        timeoutMs: 5_000,
        env
      })
      if (!result.ok || result.code !== 0) {
        return null
      }
      const rows: SimProcessRow[] = []
      for (const line of result.stdout.split('\n')) {
        const match = PS_ROW.exec(line)
        if (match) {
          rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
        }
      }
      return rows
    }
  }
}

const LAUNCHD_SIM = /(^|\/)launchd_sim(\s|$)/
const UDIDS = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g

function childrenOf(rows: readonly SimProcessRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      children.set(row.ppid, [row.pid])
    }
  }
  return children
}

function subtree(children: Map<number, number[]>, root: number, into: Set<number>): void {
  const stack = [root]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (!into.has(pid)) {
      into.add(pid)
      stack.push(...(children.get(pid) ?? []))
    }
  }
}

/** Pids of every booted simulator's own processes: each launchd_sim and all under it. */
export function simulatorProcesses(rows: readonly SimProcessRow[]): Set<number> {
  const children = childrenOf(rows)
  const inside = new Set<number>()
  for (const row of rows) {
    if (row.ppid === 1 && LAUNCHD_SIM.test(row.command)) {
      subtree(children, row.pid, inside)
    }
  }
  return inside
}

/** Every pid under each of `roots`, the roots included. */
export function processSubtrees(
  rows: readonly SimProcessRow[],
  roots: readonly number[]
): Set<number> {
  const found = new Set<number>()
  if (roots.length === 0) {
    return found
  }
  const children = childrenOf(rows)
  for (const root of roots) {
    subtree(children, root, found)
  }
  return found
}

/** UDIDs named in each process's argv. */
export function udidsIn(command: string): string[] {
  return command.match(UDIDS) ?? []
}

/** Simulators booted outside Pod's set, counted by their launchd_sim (claude-acc's own way). */
export async function simBootedOutsidePod(
  processes: SimProcessFacts,
  podDevices: ReadonlySet<string>
): Promise<number | 'unknown'> {
  const rows = await processes.table()
  if (!rows) {
    return 'unknown'
  }
  return rows.filter((row) => {
    if (row.ppid !== 1 || !LAUNCHD_SIM.test(row.command)) {
      return false
    }
    const udid = udidsIn(row.command)[0]
    return udid !== undefined && !podDevices.has(udid)
  }).length
}
