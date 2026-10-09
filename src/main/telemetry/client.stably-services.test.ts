import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'
import type { Store } from '../persistence'

const { identity, PostHogMock } = vi.hoisted(() => {
  // Why: client.ts reads these at module load to decide it is an official build.
  Object.assign(globalThis, { ORCA_BUILD_IDENTITY: 'stable', ORCA_POSTHOG_WRITE_KEY: 'phc_test' })
  const identity: { current: ProductIdentity | null } = { current: null }
  return {
    identity,
    PostHogMock: vi.fn(function PostHog(this: Record<string, unknown>) {
      Object.assign(this, { capture: vi.fn(), optIn: vi.fn(), optOut: vi.fn(), shutdown: vi.fn() })
    })
  }
})

vi.mock('posthog-node', () => ({ PostHog: PostHogMock }))
vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { initTelemetry, isTelemetryEnabled, shutdownTelemetry, track } from './client'
import { resolveConsent } from './consent'

function storeWithConsent(): Store {
  const settings = {
    telemetry: {
      installId: '00000000-0000-4000-8000-000000000000',
      optedIn: true,
      existedBeforeTelemetryRelease: false
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: initTelemetry reads only getSettings().telemetry.
  return { getSettings: () => settings } as unknown as Store
}

describe('telemetry without Stably services', () => {
  const envStash = { ...process.env }

  beforeEach(() => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED']) {
      delete process.env[name]
    }
    PostHogMock.mockClear()
  })

  afterEach(async () => {
    await shutdownTelemetry()
    identity.current = null
    process.env = { ...envStash }
  })

  it('constructs the PostHog client for upstream Orca with consent', () => {
    initTelemetry(storeWithConsent())
    expect(PostHogMock).toHaveBeenCalledTimes(1)
  })

  it('never constructs a client, so nothing is captured or queued', () => {
    identity.current = podIdentityWithoutStablyServices()
    const store = storeWithConsent()
    initTelemetry(store)

    expect(PostHogMock).not.toHaveBeenCalled()
    expect(isTelemetryEnabled()).toBe(false)
    expect(track('app_opened', {})).toBe(false)
    expect(resolveConsent(store.getSettings())).toEqual({
      effective: 'disabled',
      reason: 'orca_disabled'
    })
  })
})
