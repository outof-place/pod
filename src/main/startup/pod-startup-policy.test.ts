import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../shared/product/features'

vi.mock('./first-window-deferral', () => ({ runAfterFirstWindowShown: vi.fn() }))

async function loadPolicy(profile: 'pod' | 'orca') {
  vi.resetModules()
  if (profile === 'pod') {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
  }
  const policy = await import('./pod-startup-policy')
  const deferral = await import('./first-window-deferral')
  return { policy, runAfterFirstWindowShown: vi.mocked(deferral.runAfterFirstWindowShown) }
}

describe('Pod startup policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps upstream startup work when the profile is not substituted', async () => {
    const { policy, runAfterFirstWindowShown } = await loadPolicy('orca')
    const bridge = { sweepOrphanedSessions: vi.fn(async () => []) }
    const install = vi.fn()
    policy.sweepAgentBrowserOrphansAtStartup(bridge)
    policy.sweepAgentBrowserOrphansOnFirstUse(bridge)
    expect(policy.deferMainThreadHangWatchdog(install)).toBe(false)
    expect(bridge.sweepOrphanedSessions).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
    expect(runAfterFirstWindowShown).not.toHaveBeenCalled()
  })

  it('moves the sweep to first use and defers the watchdog in Pod', async () => {
    const { policy, runAfterFirstWindowShown } = await loadPolicy('pod')
    const bridge = { sweepOrphanedSessions: vi.fn(async () => []) }
    const install = vi.fn()
    policy.sweepAgentBrowserOrphansAtStartup(bridge)
    expect(bridge.sweepOrphanedSessions).not.toHaveBeenCalled()
    policy.sweepAgentBrowserOrphansOnFirstUse(bridge)
    policy.sweepAgentBrowserOrphansOnFirstUse(bridge)
    expect(bridge.sweepOrphanedSessions).toHaveBeenCalledTimes(1)
    expect(policy.deferMainThreadHangWatchdog(install)).toBe(true)
    expect(install).not.toHaveBeenCalled()
    expect(runAfterFirstWindowShown).toHaveBeenCalledWith(expect.any(Function), 15_000)
    install.mockImplementation(() => policy.deferMainThreadHangWatchdog(install))
    runAfterFirstWindowShown.mock.calls[0][0]()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveReturnedWith(false)
  })
})
