import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  countMachineCreates,
  createPodOrbstackChurn,
  POD_ORBSTACK_CHURN_WARN_AT
} from './pod-orbstack-churn'
import type { OrbstackToolRunner } from './pod-orbstack-tools'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-churn-'))
  roots.push(root)
  let boot: string | null = 'boot-1'
  let clock = 100
  const churn = createPodOrbstackChurn({
    file: join(root, 'churn.json'),
    bootMarker: () => boot,
    now: () => clock
  })
  return {
    churn,
    root,
    restart: (marker: string | null) => {
      boot = marker
      clock += 1_000
    }
  }
}

describe('Pod machine churn since OrbStack started', () => {
  it('counts creates and clones through the runner, nothing else', async () => {
    const { churn } = setup()
    const run: OrbstackToolRunner = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    }))
    const counted = countMachineCreates(run, churn)
    await counted('orb', ['create', 'ubuntu:24.04', 'pod-x'])
    await counted('orb', ['clone', 'pod-sbx-tmpl', 'pod-y'])
    await counted('orb', ['list', '--format', 'json'])
    await counted('orbctl', ['create'])
    expect(churn.snapshot()).toEqual({ creates: 2, since: 100, warnAt: POD_ORBSTACK_CHURN_WARN_AT })
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('starts over when OrbStack starts again, and survives a Pod restart', () => {
    const { churn, root, restart } = setup()
    churn.count()
    churn.count()
    const again = createPodOrbstackChurn({
      file: join(root, 'churn.json'),
      bootMarker: () => 'boot-1'
    })
    expect(again.snapshot().creates).toBe(2)
    restart('boot-2')
    expect(churn.snapshot()).toEqual({
      creates: 0,
      since: 1_100,
      warnAt: POD_ORBSTACK_CHURN_WARN_AT
    })
    churn.count()
    expect(churn.snapshot().creates).toBe(1)
    // No log to read: keep counting rather than reset.
    restart(null)
    expect(churn.snapshot().creates).toBe(1)
  })
})
