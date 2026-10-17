import { describe, expect, it, vi } from 'vitest'
import { createDaemonLoginPreflight } from './daemon-login-preflight'

describe("the daemon's login(1) preflight log", () => {
  it('logs every probe that ran with its duration, an accepted one too', async () => {
    const log = vi.fn()
    const prepare = vi.fn().mockResolvedValue({ ok: true, conclusive: true, reason: 'accepted' })
    await createDaemonLoginPreflight(log, prepare)(true)
    expect(prepare).toHaveBeenCalledWith({ warmUp: true })
    expect(log).toHaveBeenCalledWith('macos-login-preflight', {
      ok: true,
      conclusive: true,
      reason: 'accepted',
      durationMs: expect.any(Number),
      warmUp: true
    })
  })

  it("logs a spawn's expired wait apart from any probe's timeout", async () => {
    const log = vi.fn()
    const prepare = vi
      .fn()
      .mockResolvedValue({ ok: false, conclusive: false, reason: 'timeout', budgetExpired: true })
    await createDaemonLoginPreflight(log, prepare)()
    expect(prepare).toHaveBeenCalledWith({ warmUp: false })
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('macos-login-preflight-wait', {
      budgetExpired: true,
      waitedMs: expect.any(Number)
    })
  })

  it('logs nothing when no probe ran (a cached verdict, or not macOS)', async () => {
    const log = vi.fn()
    await createDaemonLoginPreflight(log, vi.fn().mockResolvedValue(null))()
    expect(log).not.toHaveBeenCalled()
  })
})
