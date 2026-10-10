import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

// Opt-in handover of the legacy app's running terminal daemons to the product. A move, not a
// link: the legacy app's next launch finds no endpoint at its own path and starts a fresh daemon
// instead of sharing PTYs with the product. A moved daemon's endpoint watchdog marks its name lost
// within ~60 s; it then refuses new terminals, keeps attaching existing ones, and exits once they
// end. Restore with product/scripts/restore-orca-terminals.mjs.

const DAEMON_PID_FILE = /^daemon-v(\d+)\.pid$/
const ENDPOINT_EXTENSIONS = ['sock', 'token', 'pid'] as const

export type LegacyDaemon = { protocol: number; pid: number }

export type MovedDaemon = LegacyDaemon & {
  /** File names, identical in both daemon directories. */
  files: string[]
  from: string
  to: string
}

export function isMovedDaemon(value: unknown): value is MovedDaemon {
  const field = (key: string): unknown => Reflect.get(Object(value), key)
  const files = field('files')
  return (
    typeof field('protocol') === 'number' &&
    typeof field('pid') === 'number' &&
    typeof field('from') === 'string' &&
    typeof field('to') === 'string' &&
    Array.isArray(files) &&
    files.every((file) => typeof file === 'string')
  )
}

export type LegacyDaemonHandoverResult =
  | { status: 'moved'; moved: MovedDaemon[]; skipped: { protocol: number; reason: string }[] }
  | { status: 'blocked'; reason: 'legacy-app-running'; pid: number }

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM'
  }
}

export function readPidRecord(path: string): number | null {
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const pid = typeof record === 'object' && record !== null ? Reflect.get(record, 'pid') : null
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function endpointFiles(protocol: number): string[] {
  return ENDPOINT_EXTENSIONS.map((extension) => `daemon-v${protocol}.${extension}`)
}

/** Live daemons of an attachable protocol with a complete endpoint; dead sockets are never listed. */
export function findAdoptableDaemons(
  legacyUserData: string,
  attachable: ReadonlySet<number>,
  isAlive: (pid: number) => boolean = defaultIsProcessAlive
): LegacyDaemon[] {
  const daemonDir = join(legacyUserData, 'daemon')
  if (!existsSync(daemonDir)) {
    return []
  }
  const found: LegacyDaemon[] = []
  for (const entry of readdirSync(daemonDir)) {
    const protocol = Number.parseInt(DAEMON_PID_FILE.exec(entry)?.[1] ?? '', 10)
    if (!attachable.has(protocol)) {
      continue
    }
    const pid = readPidRecord(join(daemonDir, entry))
    if (
      pid !== null &&
      isAlive(pid) &&
      endpointFiles(protocol).every((file) => existsSync(join(daemonDir, file)))
    ) {
      found.push({ protocol, pid })
    }
  }
  return found.sort((left, right) => left.protocol - right.protocol)
}

/** Moves one daemon's endpoint files without replacing anything: link every file, then unlink. */
function moveEndpoint(daemon: LegacyDaemon, from: string, to: string): MovedDaemon | string {
  const files = endpointFiles(daemon.protocol)
  if (files.some((file) => existsSync(join(to, file)))) {
    return 'product-endpoint-exists'
  }
  const linked: string[] = []
  try {
    for (const file of files) {
      // Why link, not rename: link fails on an existing name instead of replacing it.
      linkSync(join(from, file), join(to, file))
      linked.push(file)
    }
  } catch (error) {
    for (const file of linked) {
      unlinkSync(join(to, file))
    }
    return `link-failed: ${Reflect.get(Object(error), 'code') ?? String(error)}`
  }
  for (const file of files) {
    unlinkSync(join(from, file))
  }
  return { ...daemon, files, from, to }
}

export function moveLegacyDaemons(options: {
  legacyUserData: string
  productUserData: string
  attachableDaemonProtocols: readonly number[]
  /** The legacy app's SingletonLock owner, when it runs. */
  legacyAppPid: number | null
  isProcessAlive?: (pid: number) => boolean
}): LegacyDaemonHandoverResult {
  if (options.legacyAppPid !== null) {
    return { status: 'blocked', reason: 'legacy-app-running', pid: options.legacyAppPid }
  }
  const from = join(options.legacyUserData, 'daemon')
  const to = join(options.productUserData, 'daemon')
  const daemons = findAdoptableDaemons(
    options.legacyUserData,
    new Set(options.attachableDaemonProtocols),
    options.isProcessAlive
  )
  const moved: MovedDaemon[] = []
  const skipped: { protocol: number; reason: string }[] = []
  if (daemons.length === 0) {
    return { status: 'moved', moved, skipped }
  }
  mkdirSync(to, { recursive: true, mode: 0o700 })
  // Why same volume only: a cross-device move would copy, and a copied socket file is no endpoint.
  if (statSync(from).dev !== statSync(to).dev) {
    return {
      status: 'moved',
      moved,
      skipped: daemons.map(({ protocol }) => ({ protocol, reason: 'different-volume' }))
    }
  }
  for (const daemon of daemons) {
    const outcome = moveEndpoint(daemon, from, to)
    if (typeof outcome === 'string') {
      skipped.push({ protocol: daemon.protocol, reason: outcome })
    } else {
      moved.push(outcome)
    }
  }
  return { status: 'moved', moved, skipped }
}
