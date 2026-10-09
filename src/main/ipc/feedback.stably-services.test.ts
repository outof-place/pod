import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const { fetchMock, identity } = vi.hoisted(() => {
  const identity: { current: ProductIdentity | null } = { current: null }
  return { fetchMock: vi.fn(), identity }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))
vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { submitFeedback } from './feedback'

describe('feedback and crash reports without Stably services', () => {
  afterEach(() => {
    identity.current = null
    fetchMock.mockReset()
  })

  it.each(['feedback', 'crash'] as const)(
    'refuses the %s lane before any request',
    async (lane) => {
      identity.current = podIdentityWithoutStablyServices()
      const result = await submitFeedback({
        feedback: 'It broke',
        submissionType: lane,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })

      expect(result).toEqual({
        ok: false,
        status: null,
        error: 'Feedback is not available in Pod.'
      })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('still posts to onorca.dev for upstream Orca', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    await expect(
      submitFeedback({
        feedback: 'It broke',
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
    ).resolves.toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://www.onorca.dev/v1/feedback')
  })
})
