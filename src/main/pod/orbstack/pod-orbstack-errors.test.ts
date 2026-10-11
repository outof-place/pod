import { describe, expect, it } from 'vitest'
import {
  explainPodOrbstackFailure,
  POD_ORBSTACK_OUT_OF_ADDRESSES_MESSAGE
} from './pod-orbstack-errors'

describe('explainPodOrbstackFailure', () => {
  it("names OrbStack's missing machine address and keeps orb's own words as the detail", () => {
    const raw =
      "orb create pod-vm-1: [-32098] create 'pod-vm-1': setup: machine didn't start in 30s (missing IP address)"
    expect(explainPodOrbstackFailure({ ok: false, error: raw })).toEqual({
      ok: false,
      error: POD_ORBSTACK_OUT_OF_ADDRESSES_MESSAGE,
      reason: 'out-of-addresses',
      detail: raw
    })
  })

  it('leaves other failures and successes alone', () => {
    expect(explainPodOrbstackFailure({ ok: true })).toEqual({ ok: true })
    expect(explainPodOrbstackFailure({ ok: false, error: 'OrbStack is not installed.' })).toEqual({
      ok: false,
      error: 'OrbStack is not installed.'
    })
  })
})
