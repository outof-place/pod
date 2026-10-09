import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }))

const { resolveUpdateFeedPolicy } = await import('./update-feed-policy')

const feed = { provider: 'github', owner: 'outof-place', repo: 'pod' } as const

describe('resolveUpdateFeedPolicy', () => {
  it('keeps the official feed for upstream builds', () => {
    expect(resolveUpdateFeedPolicy(null, false)).toEqual({ kind: 'official' })
  })

  it('disables updates for an opted-out fork build', () => {
    expect(resolveUpdateFeedPolicy(null, true)).toEqual({ kind: 'disabled' })
  })

  it('uses the product feed, even when the manifest also opts out of the official one', () => {
    expect(resolveUpdateFeedPolicy({ updateFeed: feed }, true)).toEqual({ kind: 'product', feed })
    expect(resolveUpdateFeedPolicy({ updateFeed: feed }, false)).toEqual({ kind: 'product', feed })
  })

  it('never falls back to the official feed for a product without its own feed', () => {
    expect(resolveUpdateFeedPolicy({ updateFeed: null }, false)).toEqual({ kind: 'disabled' })
  })
})
