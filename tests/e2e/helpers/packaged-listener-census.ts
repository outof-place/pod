/**
 * Fork-only (Pod): which processes a packaged-app run owns, and the TCP and UDP ports they listen on.
 * The descendant tree alone misses processes that re-parent to launchd (the daemon after a
 * hand-over, Pod Menu, the claude-acc LaunchAgents), so the census also takes every process whose
 * executable lives inside the bundle.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export type CensusProcess = { pid: number; path: string; listeners: string[] }

type ProcessRow = { pid: number; ppid: number; path: string }

function processTable(): ProcessRow[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ps failed: ${result.stderr || result.error?.message || result.status}`)
  }
  return result.stdout.split('\n').flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), path: match[3] }] : []
  })
}

function bundleContentsPrefixes(bundle: string): string[] {
  const contents = (root: string): string => `${path.join(root, 'Contents')}${path.sep}`
  return [...new Set([contents(realpathSync(bundle)), contents(path.resolve(bundle))])]
}

function isInBundle(row: ProcessRow, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => row.path.startsWith(prefix))
}

/** Processes already running from the bundle; a run must start without any. */
export function runningBundleProcesses(bundle: string): string[] {
  const prefixes = bundleContentsPrefixes(bundle)
  return processTable()
    .filter((row) => isInBundle(row, prefixes))
    .map((row) => `${row.pid} ${row.path}`)
}

/** `-iTCP -sTCP:LISTEN` gives listening TCP sockets; `-iUDP` gives every UDP socket. */
function lsofSocketsByPid(
  pids: readonly number[],
  filter: readonly string[]
): Map<number, string[]> {
  const result = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), ...filter, '-Fpn'], {
    encoding: 'utf8'
  })
  // lsof exits 1 when nothing listens.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed: ${result.stderr || result.error?.message || result.status}`)
  }
  const listeners = new Map<number, string[]>()
  let pid = 0
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
    } else if (line.startsWith('n')) {
      listeners.set(pid, [...(listeners.get(pid) ?? []), line.slice(1)])
    }
  }
  return listeners
}

/**
 * TCP listeners as `address`, and UDP sockets bound without a peer as `udp:address`. A connected
 * UDP socket (`local->remote`, a DNS or QUIC client) receives only from its peer, so it is no listener.
 */
function listenersByPid(pids: readonly number[]): Map<number, string[]> {
  const tcp = lsofSocketsByPid(pids, ['-iTCP', '-sTCP:LISTEN'])
  const udp = lsofSocketsByPid(pids, ['-iUDP'])
  return new Map(
    pids.map((pid) => [
      pid,
      [
        ...(tcp.get(pid) ?? []),
        ...(udp.get(pid) ?? []).filter((name) => !name.includes('->')).map((name) => `udp:${name}`)
      ]
    ])
  )
}

/** The app, every process running from its bundle, and all their descendants, with their listeners. */
export function listenerCensus(rootPid: number, bundle: string): CensusProcess[] {
  const table = processTable()
  const prefixes = bundleContentsPrefixes(bundle)
  // Why seed with the bundle: a re-parented daemon's children (shells, relays) run from outside it.
  const pids = new Set([
    rootPid,
    ...table.filter((row) => isInBundle(row, prefixes)).map((row) => row.pid)
  ])
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid)
        grew = true
      }
    }
  }
  const listeners = listenersByPid([...pids])
  return [...pids]
    .sort((a, b) => a - b)
    .map((pid) => ({
      pid,
      path: table.find((row) => row.pid === pid)?.path ?? '(exited)',
      listeners: listeners.get(pid) ?? []
    }))
}

export function formatListenerCensus(census: readonly CensusProcess[]): string {
  return census
    .map(({ pid, path: executable, listeners }) => {
      const ports = listeners.length > 0 ? listeners.join(', ') : 'no listeners'
      return `${pid} ${executable}: ${ports}`
    })
    .join('\n')
}

/** `pid path address` for every TCP or UDP listener bound beyond loopback (127.0.0.0/8, ::1). */
export function wideListeners(census: readonly CensusProcess[]): string[] {
  return census.flatMap(({ pid, path: executable, listeners }) =>
    listeners
      .filter((listener) => {
        const address = listener.replace(/^udp:/, '')
        return !address.startsWith('127.') && !address.startsWith('[::1]:')
      })
      .map((address) => `${pid} ${executable} ${address}`)
  )
}

/** The Electron executable: the app's own, or the one-app layout's nested runtime's. */
export function packagedRuntimeExecutable(app: string): string {
  const nested = path.join(
    app,
    'Contents',
    'Helpers',
    'Pod Runtime.app',
    'Contents',
    'MacOS',
    'Pod'
  )
  return existsSync(nested) ? nested : path.join(app, 'Contents', 'MacOS', 'Pod')
}
