import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodOrbstackStatus } from '../../../shared/pod-orbstack-types'
import type { Repo } from '../../../shared/repo-types'
import type { PodOrbstackMachines } from './pod-orbstack-machines'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createPodOrbstackService } from './pod-orbstack-service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function emptyStatus(overrides: Partial<PodOrbstackStatus> = {}): PodOrbstackStatus {
  return {
    install: { appInstalled: true, orbPath: '/bin/orb', dockerPath: null, version: null },
    service: 'running',
    dockerContext: { current: null, currentIsOrbstack: false, orbstackContextExists: false },
    machines: [],
    containers: [],
    links: [],
    sandboxClaudeLogin: false,
    busyWorktreeIds: [],
    errors: [],
    checkedAt: 0,
    ...overrides
  }
}

function setup(repos: Repo[]) {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-service-'))
  roots.push(root)
  let clock = 0
  const readStatus = vi.fn(async () => emptyStatus({ checkedAt: clock }))
  const machines = {
    create: vi.fn(async () => ({ ok: true as const })),
    createSandbox: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
    start: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const })),
    busyWorktreeIds: () => []
  } satisfies PodOrbstackMachines
  const registry = new PodOrbstackRegistry(join(root, 'registry.json'))
  const service = createPodOrbstackService({
    enabled: true,
    getRepos: () => repos,
    machines,
    registry,
    readStatus,
    now: () => clock
  })
  return { service, readStatus, machines, registry, tick: (ms: number) => (clock += ms) }
}

const localRepo: Repo = {
  id: 'repo',
  path: '/',
  displayName: 'root',
  badgeColor: '#000',
  addedAt: 0
}

describe('createPodOrbstackService', () => {
  it('serves a burst of reads from one status read and re-reads after an action', async () => {
    const { service, readStatus, tick } = setup([localRepo])
    await Promise.all([service.snapshot(), service.snapshot(), service.snapshot()])
    expect(readStatus).toHaveBeenCalledTimes(1)
    tick(2_500)
    await service.snapshot()
    expect(readStatus).toHaveBeenCalledTimes(2)
    await service.stop('pod-x')
    await service.snapshot()
    expect(readStatus).toHaveBeenCalledTimes(3)
  })

  it('creates and pins only for local worktrees it can resolve', async () => {
    const { service, machines, registry } = setup([
      localRepo,
      { ...localRepo, id: 'remote', connectionId: 'ssh-1' }
    ])
    expect(await service.create({ worktreeId: 'remote::/', displayName: 'r' })).toMatchObject({
      ok: false
    })
    expect(service.setDockerPin('remote::/', true)).toMatchObject({ ok: false })
    expect(machines.create).not.toHaveBeenCalled()

    expect(await service.create({ worktreeId: 'repo::/', displayName: 'root' })).toEqual({
      ok: true
    })
    expect(machines.create).toHaveBeenCalledWith({
      worktreeId: 'repo::/',
      worktreePath: '/',
      displayName: 'root'
    })
    expect(service.setDockerPin('repo::/', true)).toEqual({ ok: true })
    expect(registry.isDockerPinned('repo::/')).toBe(true)
  })
})

describe('agent sandbox switch', () => {
  it('turns on only for a worktree with a ready sandbox', () => {
    const { service, registry } = setup([localRepo])
    expect(service.setAgentSandbox('repo::/', true)).toMatchObject({ ok: false })
    registry.upsert({
      name: 'pod-root-1a2b3c4d-sbx',
      worktreeId: 'repo::/',
      worktreePath: '/',
      createdAt: 0,
      state: 'ready',
      kind: 'sandbox'
    })
    expect(service.setAgentSandbox('repo::/', true)).toEqual({ ok: true })
    expect(registry.isSandboxAgents('repo::/')).toBe(true)
    expect(service.setAgentSandbox('repo::/', false)).toEqual({ ok: true })
  })
})
