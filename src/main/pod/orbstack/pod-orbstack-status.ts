import type {
  PodOrbstackMachine,
  PodOrbstackStatus,
  PodOrbstackWorktreeLink
} from '../../../shared/pod-orbstack-types'
import {
  DOCKER_PS_FORMAT,
  DOCKER_STATS_FORMAT,
  parseDockerContainers,
  parseDockerContexts,
  parseOrbMachines,
  parseOrbctlStatus,
  parseOrbctlVersion,
  withDockerStats,
  type OrbMachineRecord
} from './pod-orbstack-inventory'
import type { PodOrbstackRegistry } from './pod-orbstack-registry'
import type {
  OrbstackToolPaths,
  OrbstackToolResult,
  OrbstackToolRunner
} from './pod-orbstack-tools'

// Why longer: `docker stats --no-stream` samples for about two seconds before it prints.
const STATS_TIMEOUT_MS = 20_000

function failure(label: string, result: OrbstackToolResult): string {
  const detail = result.timedOut ? 'timed out' : result.stderr.trim().split('\n').at(-1) || 'failed'
  return `${label}: ${detail}`
}

function mergeMachines(
  listed: OrbMachineRecord[] | null,
  registry: PodOrbstackRegistry
): PodOrbstackMachine[] {
  const rows: PodOrbstackMachine[] = (listed ?? []).map((machine) => {
    const entry = registry.findByName(machine.name)
    return {
      ...machine,
      podOwned: registry.isPodOwned(machine.name),
      worktreeId: entry?.worktreeId ?? null,
      missing: false
    }
  })
  for (const entry of registry.machines()) {
    if (!rows.some((row) => row.name === entry.name)) {
      rows.push({
        name: entry.name,
        state: listed ? (entry.state === 'creating' ? 'creating' : 'missing') : 'unknown',
        distro: null,
        distroVersion: null,
        arch: null,
        podOwned: true,
        worktreeId: entry.worktreeId,
        // Only a real `orb list` can say a machine is gone.
        missing: listed !== null && entry.state === 'ready'
      })
    }
  }
  return rows
}

function buildLinks(registry: PodOrbstackRegistry): PodOrbstackWorktreeLink[] {
  const ids = new Set([
    ...registry.machines().map((entry) => entry.worktreeId),
    ...registry.dockerPins()
  ])
  return [...ids].map((worktreeId) => ({
    worktreeId,
    machine: registry.findByWorktree(worktreeId)?.name ?? null,
    dockerPinned: registry.isDockerPinned(worktreeId)
  }))
}

/** Read-only: list and inspect commands only, and none at all while OrbStack is not running. */
export async function readPodOrbstackStatus(deps: {
  paths: OrbstackToolPaths
  run: OrbstackToolRunner
  registry: PodOrbstackRegistry
  busyWorktreeIds: readonly string[]
  now?: () => number
}): Promise<PodOrbstackStatus> {
  const { paths, run, registry } = deps
  const errors: string[] = []
  const [statusResult, versionResult, contextResult] = await Promise.all([
    paths.orbctl ? run('orbctl', ['status']) : null,
    paths.orbctl ? run('orbctl', ['version']) : null,
    paths.docker ? run('docker', ['context', 'ls', '--format', 'json']) : null
  ])
  const service = statusResult
    ? parseOrbctlStatus(statusResult.code, statusResult.stdout)
    : 'unknown'
  if (contextResult && contextResult.code !== 0) {
    errors.push(failure('docker context ls', contextResult))
  }

  let listed: OrbMachineRecord[] | null = null
  let containers: PodOrbstackStatus['containers'] = []
  if (service === 'running') {
    const [machinesResult, psResult] = await Promise.all([
      run('orb', ['list', '--format', 'json']),
      paths.docker
        ? run('docker', ['--context', 'orbstack', 'ps', '--all', '--format', DOCKER_PS_FORMAT])
        : null
    ])
    listed = machinesResult.code === 0 ? parseOrbMachines(machinesResult.stdout) : null
    if (listed === null) {
      errors.push(failure('orb list', machinesResult))
    }
    if (psResult && psResult.code === 0) {
      containers = parseDockerContainers(psResult.stdout)
    } else if (psResult) {
      errors.push(failure('docker ps', psResult))
    }
    if (paths.docker && containers.some((container) => container.state === 'running')) {
      const stats = await run(
        'docker',
        ['--context', 'orbstack', 'stats', '--no-stream', '--format', DOCKER_STATS_FORMAT],
        { timeoutMs: STATS_TIMEOUT_MS }
      )
      if (stats.code === 0) {
        containers = withDockerStats(containers, stats.stdout)
      } else {
        errors.push(failure('docker stats', stats))
      }
    }
  }

  return {
    install: {
      appInstalled: paths.appInstalled,
      orbPath: paths.orb,
      dockerPath: paths.docker,
      version: versionResult?.code === 0 ? parseOrbctlVersion(versionResult.stdout) : null
    },
    service,
    dockerContext:
      contextResult?.code === 0
        ? parseDockerContexts(contextResult.stdout)
        : { current: null, currentIsOrbstack: false, orbstackContextExists: false },
    machines: mergeMachines(listed, registry),
    containers,
    links: buildLinks(registry),
    busyWorktreeIds: [...deps.busyWorktreeIds],
    errors,
    checkedAt: (deps.now ?? Date.now)()
  }
}
