import { describe, expect, it } from 'vitest'
import { SimHelperLiveViews } from './sim-helper-live-views'

const UDID = '01C2D240-07BE-4772-AB65-D00D78C451A0'
const SERVICE = 'codes.pod.native.dev.sim.0123456789abcdef0123456789abcdef'

function start(token: number, nonce: string): Record<string, unknown> {
  return { udid: UDID, service: SERVICE, token, nonce }
}

function ended(token: number, nonce: string) {
  return { udid: UDID, token, nonce, reason: 'viewerGone' as const }
}

describe('live views a replacement helper streams again', () => {
  it('forgets a view the helper ended after its start was accepted', () => {
    const views = new SimHelperLiveViews()
    views.accepted('startStream', start(8, '0000000000000008'))
    views.ended(ended(8, '0000000000000008'))
    expect(views.size).toBe(0)
  })

  // Both lines can arrive in one read: the event is handled before the reply's continuation runs.
  it('forgets a view whose end the helper sent before its start reply was handled', () => {
    const views = new SimHelperLiveViews()
    views.ended(ended(8, '0000000000000008'))
    views.accepted('startStream', start(8, '0000000000000008'))
    expect(views.size).toBe(0)
  })

  it('keeps a fresh start of the same token under another nonce', () => {
    const views = new SimHelperLiveViews()
    views.ended(ended(8, '0000000000000008'))
    views.accepted('startStream', start(8, '0000000000000009'))
    expect(views.size).toBe(1)
  })
})
