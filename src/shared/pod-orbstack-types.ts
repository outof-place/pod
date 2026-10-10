// Fork-only (Pod): OrbStack machines, containers and per-worktree links, shared by main, preload and renderer.

/** Pod creates, starts, stops and deletes only machines whose name starts with this. */
export const POD_ORBSTACK_MACHINE_PREFIX = 'pod-'

export const POD_ORBSTACK_IPC = {
  enabled: 'pod:orbstack:enabled',
  status: 'pod:orbstack:status',
  createMachine: 'pod:orbstack:createMachine',
  removeMachine: 'pod:orbstack:removeMachine',
  startMachine: 'pod:orbstack:startMachine',
  stopMachine: 'pod:orbstack:stopMachine',
  setDockerPin: 'pod:orbstack:setDockerPin'
} as const

export type PodOrbstackInstall = {
  /** OrbStack.app was found. */
  appInstalled: boolean
  /** Absolute path of the `orb` CLI; null when none was found. */
  orbPath: string | null
  /** Absolute path of the `docker` CLI; null when none was found. */
  dockerPath: string | null
  version: string | null
}

export type PodOrbstackServiceState = 'running' | 'stopped' | 'unknown'

export type PodOrbstackMachine = {
  name: string
  /** OrbStack's own word: running, stopped, starting, … Unknown while OrbStack is not running. */
  state: string
  distro: string | null
  distroVersion: string | null
  arch: string | null
  /** In Pod's registry with the pod- prefix: the only machines Pod may change. */
  podOwned: boolean
  /** The worktree a Pod machine was created for. */
  worktreeId: string | null
  /** A registered Pod machine OrbStack no longer lists. */
  missing: boolean
}

export type PodOrbstackContainer = {
  id: string
  name: string
  image: string
  state: string
  status: string
  composeProject: string | null
  /** `com.docker.compose.project.working_dir`; matches a container to a worktree. */
  composeWorkingDir: string | null
  /** Running containers only, from `docker stats --no-stream`. */
  cpuPercent: string | null
  memoryUsage: string | null
}

export type PodOrbstackDockerContext = {
  /** Name of the context the docker CLI uses now; null when docker is missing. */
  current: string | null
  currentIsOrbstack: boolean
  /** An `orbstack` context exists. */
  orbstackContextExists: boolean
}

export type PodOrbstackWorktreeLink = {
  worktreeId: string
  /** The Pod machine new terminals of this worktree open in. */
  machine: string | null
  /** New Mac terminals of this worktree get DOCKER_CONTEXT=orbstack. */
  dockerPinned: boolean
}

export type PodOrbstackStatus = {
  install: PodOrbstackInstall
  service: PodOrbstackServiceState
  dockerContext: PodOrbstackDockerContext
  machines: PodOrbstackMachine[]
  containers: PodOrbstackContainer[]
  links: PodOrbstackWorktreeLink[]
  /** Worktree ids with a create or remove in flight. */
  busyWorktreeIds: string[]
  /** Commands that failed while reading the status; the rest is still shown. */
  errors: string[]
  checkedAt: number
}

export type PodOrbstackActionResult = { ok: true } | { ok: false; error: string }
