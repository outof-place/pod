import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { readPodOrbstackStatus } from './pod-orbstack-status'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function registry(): PodOrbstackRegistry {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-status-'))
  roots.push(root)
  const value = new PodOrbstackRegistry(join(root, 'registry.json'))
  value.upsert({
    name: 'pod-web-1a2b3c4d',
    worktreeId: 'repo::/Users/me/web',
    worktreePath: '/Users/me/web',
    createdAt: 1,
    state: 'ready'
  })
  return value
}

const ok = (stdout: string): OrbstackToolResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false
})

function fakeRunner(service: 'Running' | 'Stopped', calls: string[]): OrbstackToolRunner {
  return async (tool, args) => {
    const call = `${tool} ${args.join(' ')}`
    calls.push(call)
    if (call === 'orbctl status') {
      return { ...ok(`${service}\n`), code: service === 'Running' ? 0 : 1 }
    }
    if (call === 'orbctl version') {
      return ok('Version: 2.2.3 (2020300)\n')
    }
    if (call.startsWith('docker context ls')) {
      return ok(
        '{"Current":true,"DockerEndpoint":"unix:///Users/me/.orbstack/run/docker.sock","Name":"orbstack"}\n'
      )
    }
    if (call.startsWith('orb list')) {
      return ok('[{"name":"dev","state":"running","image":{"distro":"ubuntu"}}]')
    }
    if (call.includes(' ps ')) {
      return ok(
        '{"id":"abc","name":"web-1","image":"nginx","state":"running","status":"Up","project":"web","workingDir":"/Users/me/web"}'
      )
    }
    if (call.includes(' stats ')) {
      return ok('{"id":"abc","cpu":"0.5%","mem":"10MiB / 1GiB"}')
    }
    return { code: 1, stdout: '', stderr: `unexpected ${call}`, timedOut: false }
  }
}

const paths = { appInstalled: true, orb: '/bin/orb', orbctl: '/bin/orbctl', docker: '/bin/docker' }

describe('readPodOrbstackStatus', () => {
  it('lists machines, containers with stats, and marks Pod machines OrbStack lost', async () => {
    const calls: string[] = []
    const status = await readPodOrbstackStatus({
      paths,
      run: fakeRunner('Running', calls),
      registry: registry(),
      busyWorktreeIds: [],
      now: () => 7
    })

    expect(status).toMatchObject({
      install: { version: '2.2.3' },
      service: 'running',
      dockerContext: { current: 'orbstack', currentIsOrbstack: true },
      containers: [{ id: 'abc', cpuPercent: '0.5%', composeWorkingDir: '/Users/me/web' }],
      links: [
        { worktreeId: 'repo::/Users/me/web', machine: 'pod-web-1a2b3c4d', dockerPinned: false }
      ],
      errors: [],
      checkedAt: 7
    })
    expect(status.machines).toEqual([
      expect.objectContaining({ name: 'dev', podOwned: false, missing: false }),
      expect.objectContaining({ name: 'pod-web-1a2b3c4d', podOwned: true, missing: true })
    ])
    // Read-only: nothing that changes OrbStack state.
    expect(calls.some((call) => /\b(create|delete|start|stop|run)\b/.test(call))).toBe(false)
  })

  it('runs no machine or container commands while OrbStack is stopped', async () => {
    const calls: string[] = []
    const status = await readPodOrbstackStatus({
      paths,
      run: fakeRunner('Stopped', calls),
      registry: registry(),
      busyWorktreeIds: ['repo::/Users/me/web']
    })

    expect(status.service).toBe('stopped')
    expect(status.machines).toEqual([
      expect.objectContaining({ name: 'pod-web-1a2b3c4d', state: 'unknown', missing: false })
    ])
    expect(status.busyWorktreeIds).toEqual(['repo::/Users/me/web'])
    expect(calls.sort()).toEqual([
      'docker context ls --format json',
      'orbctl status',
      'orbctl version'
    ])
  })
})
