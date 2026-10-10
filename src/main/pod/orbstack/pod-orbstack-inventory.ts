import { z } from 'zod'
import type {
  PodOrbstackContainer,
  PodOrbstackDockerContext,
  PodOrbstackServiceState
} from '../../../shared/pod-orbstack-types'

export type OrbMachineRecord = {
  name: string
  state: string
  distro: string | null
  distroVersion: string | null
  arch: string | null
}

const OrbMachineSchema = z.object({
  name: z.string().min(1),
  state: z.string().optional(),
  image: z
    .object({
      distro: z.string().optional(),
      version: z.string().optional(),
      arch: z.string().optional()
    })
    .optional()
})

const DockerContextSchema = z.object({
  Name: z.string(),
  Current: z.boolean().optional(),
  DockerEndpoint: z.string().optional()
})

const DockerContainerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  project: z.string(),
  workingDir: z.string()
})

const DockerStatsSchema = z.object({ id: z.string().min(1), cpu: z.string(), mem: z.string() })

/** `docker ps` template: one JSON object per line, with the compose labels pulled out. */
export const DOCKER_PS_FORMAT =
  '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},' +
  '"status":{{json .Status}},"project":{{json (.Label "com.docker.compose.project")}},' +
  '"workingDir":{{json (.Label "com.docker.compose.project.working_dir")}}}'

export const DOCKER_STATS_FORMAT =
  '{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"mem":{{json .MemUsage}}}'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Why both shapes: older docker CLIs print one JSON array, newer ones one object per line.
function parseJsonRows(stdout: string): unknown[] {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed)
    return Array.isArray(parsed) ? parsed : []
  }
  return trimmed
    .split('\n')
    .map((line) => parseJson(line.trim()))
    .filter((row) => row !== undefined)
}

export function parseOrbMachines(stdout: string): OrbMachineRecord[] | null {
  const parsed = parseJson(stdout.trim() || '[]')
  if (!Array.isArray(parsed)) {
    return null
  }
  const machines: OrbMachineRecord[] = []
  for (const row of parsed) {
    const result = OrbMachineSchema.safeParse(row)
    if (result.success) {
      machines.push({
        name: result.data.name,
        state: result.data.state ?? 'unknown',
        distro: result.data.image?.distro ?? null,
        distroVersion: result.data.image?.version ?? null,
        arch: result.data.image?.arch ?? null
      })
    }
  }
  return machines
}

const ORBSTACK_SOCKET_SUFFIX = '/.orbstack/run/docker.sock'

export function parseDockerContexts(stdout: string): PodOrbstackDockerContext {
  const contexts = parseJsonRows(stdout).flatMap((row) => {
    const result = DockerContextSchema.safeParse(row)
    return result.success ? [result.data] : []
  })
  const current = contexts.find((context) => context.Current === true) ?? null
  const isOrbstack = (context: z.infer<typeof DockerContextSchema>): boolean =>
    context.Name === 'orbstack' || (context.DockerEndpoint ?? '').endsWith(ORBSTACK_SOCKET_SUFFIX)
  return {
    current: current?.Name ?? null,
    currentIsOrbstack: current ? isOrbstack(current) : false,
    orbstackContextExists: contexts.some((context) => context.Name === 'orbstack')
  }
}

export function parseDockerContainers(stdout: string): PodOrbstackContainer[] {
  return parseJsonRows(stdout).flatMap((row) => {
    const result = DockerContainerSchema.safeParse(row)
    if (!result.success) {
      return []
    }
    const container = result.data
    return [
      {
        id: container.id,
        name: container.name,
        image: container.image,
        state: container.state,
        status: container.status,
        composeProject: container.project || null,
        composeWorkingDir: container.workingDir || null,
        cpuPercent: null,
        memoryUsage: null
      }
    ]
  })
}

/** Joins `docker stats` rows onto containers; stats ids may be shorter or longer than ps ids. */
export function withDockerStats(
  containers: PodOrbstackContainer[],
  statsStdout: string
): PodOrbstackContainer[] {
  const stats = parseJsonRows(statsStdout).flatMap((row) => {
    const result = DockerStatsSchema.safeParse(row)
    return result.success ? [result.data] : []
  })
  return containers.map((container) => {
    const row = stats.find(
      (entry) => entry.id.startsWith(container.id) || container.id.startsWith(entry.id)
    )
    return row ? { ...container, cpuPercent: row.cpu, memoryUsage: row.mem } : container
  })
}

export function parseOrbctlVersion(stdout: string): string | null {
  return /Version:\s*(\S+)/.exec(stdout)?.[1] ?? null
}

export function parseOrbctlStatus(code: number | null, stdout: string): PodOrbstackServiceState {
  const word = stdout.trim().toLowerCase()
  if (word === 'running') {
    return 'running'
  }
  // orbctl status exits non-zero while OrbStack is stopped.
  if (word === 'stopped' || (code !== null && code !== 0 && word.includes('stopped'))) {
    return 'stopped'
  }
  return 'unknown'
}
