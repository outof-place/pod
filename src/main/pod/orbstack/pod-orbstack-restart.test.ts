import { describe, expect, it, vi } from 'vitest'
import { restartPodOrbstack } from './pod-orbstack-restart'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

const ok: OrbstackToolResult = { code: 0, stdout: '', stderr: '', timedOut: false }

describe('restartPodOrbstack', () => {
  it('stops then starts OrbStack, after ending the readers', async () => {
    const calls: string[] = []
    const run: OrbstackToolRunner = vi.fn(async (tool, args) => {
      calls.push(`${tool} ${args.join(' ')}`)
      return ok
    })
    const beforeStop = vi.fn(() => calls.push('readers closed'))
    await expect(
      restartPodOrbstack({ run, busyWorktreeIds: () => [], beforeStop, env: {} })
    ).resolves.toEqual({
      ok: true
    })
    expect(calls).toEqual(['readers closed', 'orbctl stop', 'orbctl start'])
  })

  it('refuses while Pod is changing a machine', async () => {
    const run: OrbstackToolRunner = vi.fn(async () => ok)
    const result = await restartPodOrbstack({ run, busyWorktreeIds: () => ['wt-1'], env: {} })
    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("reports the step that failed and doesn't start after a failed stop", async () => {
    const run: OrbstackToolRunner = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'some line\nnot running',
      timedOut: false
    }))
    await expect(restartPodOrbstack({ run, busyWorktreeIds: () => [], env: {} })).resolves.toEqual({
      ok: false,
      error: 'orbctl stop: not running'
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never restarts from a test profile', async () => {
    const run: OrbstackToolRunner = vi.fn(async () => ok)
    const result = await restartPodOrbstack({
      run,
      busyWorktreeIds: () => [],
      env: { ORCA_E2E_USER_DATA_DIR: '/tmp/profile' }
    })
    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
