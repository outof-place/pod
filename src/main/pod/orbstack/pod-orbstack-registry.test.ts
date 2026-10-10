import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PodOrbstackRegistry } from './pod-orbstack-registry'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function registryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-registry-'))
  roots.push(root)
  return join(root, 'pod-orbstack', 'registry.json')
}

const entry = {
  name: 'pod-web-1a2b3c4d',
  worktreeId: 'repo::/Users/me/web',
  worktreePath: '/Users/me/web',
  createdAt: 1,
  state: 'ready' as const
}

describe('PodOrbstackRegistry', () => {
  it('persists machines and docker pins across instances', () => {
    const path = registryPath()
    const first = new PodOrbstackRegistry(path)
    first.upsert(entry)
    first.setDockerPin(entry.worktreeId, true)

    const second = new PodOrbstackRegistry(path)
    expect(second.findByWorktree(entry.worktreeId)).toEqual({ ...entry, kind: 'shared' })
    expect(second.findByWorktree(entry.worktreeId, 'sandbox')).toBeNull()
    expect(second.isDockerPinned(entry.worktreeId)).toBe(true)
    second.setDockerPin(entry.worktreeId, false)
    second.remove(entry.name)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      machines: [],
      dockerPins: [],
      sandboxAgents: []
    })
  })

  it('owns a machine only with the pod- prefix and a registry entry', () => {
    const registry = new PodOrbstackRegistry(registryPath())
    registry.upsert(entry)
    expect(registry.isPodOwned(entry.name)).toBe(true)
    expect(registry.isPodOwned('pod-someone-else')).toBe(false)
    expect(() => registry.upsert({ ...entry, name: 'ubuntu' })).toThrow()
  })

  it('treats a corrupt file as empty instead of failing', () => {
    const path = registryPath()
    new PodOrbstackRegistry(path).upsert(entry)
    writeFileSync(path, '{"version":1,"machines":[{"name":"ubuntu"}]}')
    expect(new PodOrbstackRegistry(path).machines()).toEqual([])
  })
})
