import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from './app-environment'
import {
  NativeProcessSnapshotClient,
  nativeProcessSnapshotWorkerFactory
} from '../main/native-process-snapshot-client'

/** One row as `ps -o pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=` would print it. */
export type NativeProcessRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  tty: string
  startTime: string
}

/** Only the columns needed to verify a pane's resize signal target. */
export type NativeProcessForegroundRow = {
  pid: number
  tpgid: number
  tty: string
}

export type NativeTerminalProcessRow = NativeProcessRow & {
  /** argv joined like `ps -o command=`; null when the kernel refuses (another user's process). */
  command: string | null
  /** The kernel's short process name (`p_comm`). */
  name: string
  /** The executable, present when argv is withheld but proc_pidpath still answers. */
  path?: string
}

/** `native/proc-info-darwin`: sysctl/proc_pidinfo reads that replace forking `ps` and `lsof`. */
export type NativeProcessInfoAddon = {
  listProcesses(): NativeProcessRow[]
  /** Every process with argv, as the full `ps` capture reads it. */
  listProcessesWithCommands(): NativeTerminalProcessRow[]
  /** With expectedTty, tty reports that terminal or '??' after checking its device identity. */
  readProcess(pid: number, expectedTty?: string): NativeProcessRow | null
  /** Checks the supplied PTY device; tty is '??' when the process holds another terminal. */
  readProcessForegroundGroup(pid: number, expectedTty: string): NativeProcessForegroundRow | null
  /** Every process on one terminal, or null when the terminal does not exist. */
  listTerminalProcesses(tty: string): NativeTerminalProcessRow[] | null
  readProcessCwd(pid: number): string | null
}

export type NativeProcessInfo = Omit<
  NativeProcessInfoAddon,
  'listProcesses' | 'listProcessesWithCommands'
> & {
  listProcesses(): NativeProcessRow[] | Promise<NativeProcessRow[]>
  listProcessesWithCommands(): NativeTerminalProcessRow[] | Promise<NativeTerminalProcessRow[]>
}

export const NATIVE_PROCESS_INFO_RESOURCE_PATH = join('native', 'orca-proc-info.node')
export const NATIVE_PROCESS_INFO_BUILD_PATH = join(
  'native',
  'proc-info-darwin',
  '.build',
  'release',
  'orca-proc-info.node'
)

function isNativeProcessInfo(value: unknown): value is NativeProcessInfoAddon {
  return (
    typeof value === 'object' &&
    value !== null &&
    'listProcesses' in value &&
    typeof value.listProcesses === 'function' &&
    'listProcessesWithCommands' in value &&
    typeof value.listProcessesWithCommands === 'function' &&
    'readProcess' in value &&
    typeof value.readProcess === 'function' &&
    'readProcessForegroundGroup' in value &&
    typeof value.readProcessForegroundGroup === 'function' &&
    'listTerminalProcesses' in value &&
    typeof value.listTerminalProcesses === 'function' &&
    'readProcessCwd' in value &&
    typeof value.readProcessCwd === 'function'
  )
}

function candidatePath(): { path: string | null; definitive: boolean } {
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : null
  // Packaged Electron Node-mode daemons expose resourcesPath before an app environment exists.
  if (resourcesPath && existsSync(join(resourcesPath, 'app.asar'))) {
    return { path: join(resourcesPath, NATIVE_PROCESS_INFO_RESOURCE_PATH), definitive: true }
  }
  // Development uses an explicit app root; hosts without one retain ps.
  const environment = hasAppEnvironment() ? getAppEnvironment() : null
  return {
    path:
      environment && !environment.isPackaged()
        ? join(environment.getAppPath(), NATIVE_PROCESS_INFO_BUILD_PATH)
        : null,
    definitive: environment !== null
  }
}

/** Load the addon at `path`; null when it is missing or not the expected module. */
export function loadNativeProcessInfoFrom(path: string): NativeProcessInfoAddon | null {
  try {
    const addon = { exports: {} }
    process.dlopen(addon, path)
    return isNativeProcessInfo(addon.exports) ? addon.exports : null
  } catch {
    return null
  }
}

let cached: NativeProcessInfo | null | undefined
let snapshotClient: NativeProcessSnapshotClient | null = null

/** Escape hatch back to the `ps`/`lsof` paths; the unit-test setup sets it so mocks stay in charge. */
export const DISABLE_NATIVE_PROCESS_INFO_ENV = 'ORCA_DISABLE_NATIVE_PROCESS_INFO'

/** The macOS process-info addon, or null where it is absent so callers keep forking `ps`/`lsof`. */
export function getNativeProcessInfo(): NativeProcessInfo | null {
  if (cached === undefined) {
    const enabled =
      process.platform === 'darwin' && process.env[DISABLE_NATIVE_PROCESS_INFO_ENV] !== '1'
    const candidate = enabled ? candidatePath() : { path: null, definitive: true }
    const addon =
      candidate.path && existsSync(candidate.path)
        ? loadNativeProcessInfoFrom(candidate.path)
        : null
    if (addon && candidate.path) {
      const client = new NativeProcessSnapshotClient(
        nativeProcessSnapshotWorkerFactory(candidate.path)
      )
      snapshotClient = client
      if (hasAppEnvironment()) {
        getAppEnvironment().onWillQuit(() => client.dispose())
      }
      cached = {
        ...addon,
        listProcesses: () => client.listProcesses(),
        listProcessesWithCommands: () => client.listProcessesWithCommands()
      }
    } else if (candidate.definitive) {
      cached = null
    }
  }
  return cached ?? null
}

export function setNativeProcessInfoForTests(value: NativeProcessInfo | null | undefined): void {
  snapshotClient?.dispose()
  snapshotClient = null
  cached = value
}
