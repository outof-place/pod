import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { appBundlePath, startPodAccSupervisor } from './acc-supervisor'

function result(code: number): ProcessResult {
  return { code, signal: null, stdout: '', stderr: '', timedOut: false }
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
      home: '/nonexistent/home',
      platform: 'darwin',
      env: {},
      run,
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
})
