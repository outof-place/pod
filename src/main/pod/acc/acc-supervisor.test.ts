import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { appBundlePath, startPodAccSupervisor } from './acc-supervisor'

function result(code: number): ProcessResult {
  return { code, signal: null, stdout: '', stderr: '', timedOut: false }
}

const ACCOUNT = {
  home: '/nonexistent/home',
  accountHome: '/nonexistent/home',
  userDataPath: '/nonexistent/home/Library/Application Support/Pod',
  defaultUserDataPath: '/nonexistent/home/Library/Application Support/Pod'
}

describe('claude-acc supervisor', () => {
  it('finds the app bundle from the executable', () => {
    expect(appBundlePath('/Applications/Pod.app/Contents/MacOS/Pod')).toBe('/Applications/Pod.app')
  })

  it('yields the tray to the running menu helper and re-applies it when that changes', async () => {
    let helper = true
    const run = vi.fn(async (spec: ProcessSpec) =>
      spec.program === '/usr/bin/pgrep' ? result(helper ? 0 : 1) : result(0)
    )
    let yieldTo: (() => boolean) | null = null
    const syncTray = vi.fn()
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      resourcesPath: '/nonexistent/Resources',
      execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
      ...ACCOUNT,
      platform: 'darwin',
      env: {},
      run,
      hasTray: true,
      setTrayYield: (fn) => {
        yieldTo = fn
      },
      syncTray,
      log
    })
    await supervisor.lifecycle
    await vi.waitFor(() => expect(syncTray).toHaveBeenCalled())
    expect(yieldTo!()).toBe(true)
    expect(log).toHaveBeenCalledWith('claude-acc: skipped (no-payload)')
    expect(run.mock.calls.every(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(true)
    supervisor.stop()
    helper = false
  })

  it('never probes the menu helper where Pod has no tray', async () => {
    const run = vi.fn(async (_spec: ProcessSpec) => result(0))
    const setTrayYield = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      resourcesPath: '/nonexistent/Resources',
      execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
      ...ACCOUNT,
      platform: 'darwin',
      env: {},
      run,
      hasTray: false,
      setTrayYield,
      syncTray: () => {},
      log: () => {}
    })
    await supervisor.lifecycle
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(run.mock.calls.some(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(false)
    expect(setTrayYield).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('skips the lifecycle for a harness launch with a throwaway HOME and profile', async () => {
    const run = vi.fn(async (_spec: ProcessSpec) => result(1))
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      resourcesPath: '/nonexistent/Resources',
      execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
      ...ACCOUNT,
      home: '/private/tmp/e2e-home',
      userDataPath: '/private/tmp/e2e-home/userData',
      platform: 'darwin',
      env: { ORCA_E2E_USER_DATA_DIR: '/private/tmp/e2e-home/userData' },
      run,
      hasTray: true,
      setTrayYield: () => {},
      syncTray: () => {},
      log
    })
    await expect(supervisor.lifecycle).resolves.toMatchObject({
      status: 'skipped',
      decision: { reason: 'automated-launch' }
    })
    expect(log).toHaveBeenCalledWith('claude-acc: skipped (automated-launch)')
    expect(run.mock.calls.every(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(true)
    supervisor.stop()
  })
})
