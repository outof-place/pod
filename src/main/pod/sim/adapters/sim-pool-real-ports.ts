// Fork-only (Pod): the pool's ports built from the real adapters, for one runtime. Stage 7 starts
// it with the RPC; until then the real-simctl tests are its only users. Nothing here starts a timer
// or a process: ports act only when the coordinator calls them. Off macOS none are made, and the
// store, the driver and the lease files each refuse on their own as well. The app module (stage 5)
// is made here too, over the same driver, store and home claim: its port fills the pool's `apps`,
// and stage 7 reaches the rest of it (prepare, open, reconcile, builds) as `appReadiness`.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createSimApps, type SimApps } from '../apps/sim-app-readiness'
import { SIM_POOL_DEFAULTS } from '../pool/sim-pool-config'
import type { SimPoolPorts } from '../pool/sim-pool-coordinator'
import type { SimAppPort, SimRuntime, SimSlimProfile, SimWaiterPort } from '../pool/sim-pool-ports'
import { createClaudeAccCapacity } from '../claude-acc/sim-claude-acc-capacity'
import { createClaudeAccLeaseFiles } from '../claude-acc/sim-claude-acc-lease-files'
import { readTextOrNull, type ClaudeAccPaths } from '../claude-acc/sim-claude-acc-paths'
import { createSimClock, simIds, type SimPowerEvents } from './sim-clock'
import { simRunProcess, type SimRun } from './sim-command-run'
import { createSimDeviceDriver } from './sim-device-driver'
import { createSimLiveness, type SimPodPanes } from './sim-liveness'
import { simDevicesOnDisk, simPodHomeClaimer, type SimPodHome } from './sim-pod-home'
import {
  createSimProcessFacts,
  simBootedOutsidePod,
  type SimNativeProcesses,
  type SimProcessFacts
} from './sim-process-facts'
import { createSimRegistryFileStore, type SimRegistryTimingPhase } from './sim-registry-file-store'

export type SimRealPortsOptions = Readonly<{
  home: SimPodHome
  // claude-acc's lease directory (claudeAccLeaseDirectory), or a test's own.
  leaseDirectory: string
  claudeAcc: ClaudeAccPaths
  self: SimRuntime
  waiters: SimWaiterPort
  // Electron's powerMonitor in the runtime; null where there is none (tests).
  power: SimPowerEvents | null
  // This runtime's panes and agent sessions; null until stage 7 wires them (holders keep leases).
  panes: SimPodPanes | null
  podCap?: number
  // Stands in for the app module's port (tests); the real one is made otherwise.
  apps?: SimAppPort
  // A dev-client build this runtime started ended: run `buildFinished` on the pool at once.
  onBuildFinished?: (buildId: string, ok: boolean) => void
  native?: SimNativeProcesses | null
  run?: SimRun
  slimProfileFile?: (profile: SimSlimProfile) => string | null
  onRegistryTiming?: (phase: SimRegistryTimingPhase, ms: number) => void
  platform?: NodeJS.Platform
}>

export type SimRealPorts = SimPoolPorts & { appReadiness: SimApps; dispose(): void }

export type SimRealPortsMade =
  | Readonly<{ ok: true; ports: SimRealPorts }>
  | Readonly<{ ok: false; reason: 'notMacOS'; message: string }>

export function createSimRealPorts(options: SimRealPortsOptions): SimRealPortsMade {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return { ok: false, reason: 'notMacOS', message: 'the simulator pool runs only on macOS' }
  }
  const run = options.run ?? simRunProcess
  const { home } = options
  const claim = simPodHomeClaimer(home, { platform })
  const podDevices = () => simDevicesOnDisk(home.deviceSet)
  const processes = createSimProcessFacts({ run, native: options.native ?? null })
  const clock = createSimClock(options.power)
  const store = createSimRegistryFileStore({
    home,
    claim,
    ...(options.onRegistryTiming ? { onTiming: options.onRegistryTiming } : {})
  })
  const devices = createSimDeviceDriver({
    deviceSet: home.deviceSet,
    run,
    ensureSet: async (deviceSet) => {
      const claimed = await claim()
      if (!claimed.ok) {
        throw new Error(claimed.message)
      }
      await mkdir(deviceSet, { recursive: true, mode: 0o700 })
    },
    ...(options.slimProfileFile ? { slimProfileFile: options.slimProfileFile } : {}),
    processes
  })
  const liveness = createSimLiveness({
    deviceSet: home.deviceSet,
    processes,
    panes: options.panes,
    podDevices
  })
  const appReadiness = createSimApps({
    home,
    claim,
    store,
    device: devices,
    self: options.self,
    processes,
    runtimeState: (ref) => liveness.runtime(ref),
    claudeAcc: options.claudeAcc.binary,
    run,
    userHome: homedir(),
    ...(options.onBuildFinished ? { onBuildFinished: options.onBuildFinished } : {})
  })
  const ports: SimRealPorts = {
    store,
    clock,
    ids: simIds,
    devices,
    capacity: createClaudeAccCapacity({
      podCap: options.podCap ?? SIM_POOL_DEFAULTS.podCap,
      podDevices,
      binary: options.claudeAcc.binary,
      stateFile: options.claudeAcc.stateFile,
      run,
      readText: readTextOrNull,
      bootedOutsidePod: async () => {
        const pod = await podDevices()
        return pod ? simBootedOutsidePod(processes, pod) : 'unknown'
      }
    }),
    liveness,
    leaseFiles: createClaudeAccLeaseFiles({ directory: options.leaseDirectory, platform }),
    waiters: options.waiters,
    apps: options.apps ?? appReadiness.port,
    appReadiness,
    dispose: () => clock.dispose()
  }
  return { ok: true, ports }
}

/**
 * This runtime as the registry names it: its pid, its start as every peer reads it (the process
 * table, SimProcessId), and a stable id of its Pod profile (a hash of the userData path, the same
 * after a restart, another for a probe's profile). Null while its own start cannot be read: a
 * runtime its peers cannot check must not write to the registry.
 */
export async function simRuntimeOf(
  userDataPath: string,
  processes: SimProcessFacts
): Promise<SimRuntime | null> {
  const start = await processes.startOf(process.pid)
  if (start === 'unknown' || !start.found) {
    return null
  }
  return {
    pid: process.pid,
    startedAt: start.startedAt,
    profile: createHash('sha256').update(userDataPath).digest('hex').slice(0, 32)
  }
}
