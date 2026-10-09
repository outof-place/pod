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
    'listTerminalProcesses' in value &&
    typeof value.listTerminalProcesses === 'function' &&
    'readProcessCwd' in value &&
    typeof value.readProcessCwd === 'function'
  )
}

function candidatePaths(): string[] {
  // Why the probe: Electron adds resourcesPath; the CLI's plain-Node types do not declare it.
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : null
  // Why app.asar decides: the terminal daemon runs as plain Node with no app environment, and a
  // packaged app must never load a native module from whatever checkout it was launched in.
  if (resourcesPath && existsSync(join(resourcesPath, 'app.asar'))) {
    return [join(resourcesPath, NATIVE_PROCESS_INFO_RESOURCE_PATH)]
  }
  // Why only an Electron dev checkout: a plain-Node host (relay, orcad, a dev daemon) must not load
  // a native module from its working directory; those keep forking `ps`.
  const environment = hasAppEnvironment() ? getAppEnvironment() : null
  return environment && !environment.isPackaged()
    ? [join(environment.getAppPath(), NATIVE_PROCESS_INFO_BUILD_PATH)]
    : []
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
    const path = enabled ? candidatePaths().find(existsSync) : undefined
    const addon = path ? loadNativeProcessInfoFrom(path) : null
    if (addon && path) {
      const client = new NativeProcessSnapshotClient(nativeProcessSnapshotWorkerFactory(path))
      snapshotClient = client
      if (hasAppEnvironment()) {
        getAppEnvironment().onWillQuit(() => client.dispose())
      }
      cached = {
        ...addon,
        listProcesses: () => client.listProcesses(),
        listProcessesWithCommands: () => client.listProcessesWithCommands()
      }
    } else if (!enabled || hasAppEnvironment()) {
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
