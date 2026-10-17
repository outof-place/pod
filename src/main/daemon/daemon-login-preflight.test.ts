import { describe, expect, it, vi } from 'vitest'
import { createDaemonLoginPreflight } from './daemon-login-preflight'
import type { prepareMacosTccLoginShell } from '../providers/macos-tcc-login-shell'

type Prepare = typeof prepareMacosTccLoginShell

describe("the daemon's login(1) preflight log", () => {
  it("logs a probe once, by the call that started it, with the probe's own duration", async () => {
    const log = vi.fn()
    const accepted = { ok: true, conclusive: true, reason: 'accepted' } as const
    const prepare = vi.fn<Prepare>(async (options) => {
      options?.onProbeSettled?.(accepted, 1_234)
      return accepted
    })
    await createDaemonLoginPreflight(log, prepare)(true)
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ warmUp: true }))
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('macos-login-preflight', {
      ok: true,
      conclusive: true,
      reason: 'accepted',
      durationMs: 1_234,
      warmUp: true
    })
  })

  it("logs a spawn's expired wait apart from any probe's verdict", async () => {
    const log = vi.fn()
    const prepare = vi.fn<Prepare>(async () => ({
      ok: false,
      conclusive: false,
      reason: 'timeout',
      budgetExpired: true
    }))
    await createDaemonLoginPreflight(log, prepare)()
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ warmUp: false }))
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('macos-login-preflight-wait', {
      budgetExpired: true,
      waitedMs: expect.any(Number)
    })
  })

  it('logs nothing for a call that joined a probe or found a cached verdict', async () => {
    const log = vi.fn()
    const joined = vi.fn<Prepare>(async () => ({ ok: true, conclusive: true, reason: 'accepted' }))
    await createDaemonLoginPreflight(log, joined)()
    await createDaemonLoginPreflight(
      log,
      vi.fn<Prepare>(async () => null)
    )()
    expect(log).not.toHaveBeenCalled()
  })
})
