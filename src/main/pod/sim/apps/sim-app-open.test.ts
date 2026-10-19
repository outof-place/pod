// `open` answers a refusal even when the Metro it started on the way fails: nothing is left to
// reject unheard.
import { describe, expect, it } from 'vitest'
import type { SimClientLookup } from './sim-app-client-lookup'
import type { SimInstalledRecords } from './sim-app-device'
import type { SimMetros } from './sim-app-metro'
import { createSimAppOpen } from './sim-app-open'
import { DEVICE, fakeDevice } from './sim-app.test-support'

describe('opening an app whose client lookup is refused', () => {
  it('answers the refusal, and the Metro start that failed meanwhile rejects nothing unheard', async () => {
    const unheard: unknown[] = []
    const listen = (reason: unknown) => unheard.push(reason)
    process.on('unhandledRejection', listen)
    try {
      const refusal = { code: 'bad_recipe', path: 'simulators.apps.app.fingerprint', problem: 'x' }
      const lookup: SimClientLookup = {
        find: async () => ({ refusal: { ...refusal, code: 'bad_recipe' } }),
        buildRefusal: async () => null
      }
      const metros: SimMetros = {
        ensure: () => new Promise((_, reject) => setTimeout(() => reject(new Error('EACCES')), 10)),
        waitReady: async () => ({ ok: false, message: 'not asked' }),
        warm: async () => null,
        probe: async () => 'none',
        reconcile: async () => [],
        unstarted: async () => [],
        logPath: () => '/dev/null'
      }
      const installed: SimInstalledRecords = {
        get: async () => null,
        set: async () => undefined,
        forget: async () => undefined
      }
      const open = createSimAppOpen({
        resolve: async () => ({
          ok: true,
          id: 'app',
          app: { bundleId: 'com.example.podsim', path: 'apps/app', metro: { port: 8081 } },
          warnings: []
        }),
        lookup,
        device: fakeDevice(),
        installed,
        metros,
        now: Date.now,
        connectMs: 400,
        bundleSilenceMs: 45_000
      })
      expect(await open({ worktreeRoot: '/w', udid: DEVICE })).toEqual({ ok: false, refusal })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unheard).toEqual([])
    } finally {
      process.off('unhandledRejection', listen)
    }
  })
})
