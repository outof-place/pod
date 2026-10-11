import { afterEach, describe, expect, it } from 'vitest'
import {
  beginPodUiHostWindowSleep,
  endPodUiHostWindowSleep,
  podUiHostRefusesAutomaticFocus,
  podUiHostWorktreeSleepHeld
} from './pod-ui-host-sleep-hold'

const WT = 'repo::/w'

describe('pod-ui-host-sleep-hold', () => {
  afterEach(() => endPodUiHostWindowSleep(WT))

  it("keeps the runtime's own hold in every launch", () => {
    expect(podUiHostWorktreeSleepHeld(WT, true, false)).toBe(true)
    expect(podUiHostWorktreeSleepHeld(WT, false, false)).toBe(false)
  })

  it("holds a one-app window's sleep while it is under way, at most 30 s", () => {
    beginPodUiHostWindowSleep(WT, 1_000)
    expect(podUiHostWorktreeSleepHeld(WT, false, true, 1_000)).toBe(true)
    expect(podUiHostWorktreeSleepHeld(WT, false, false, 1_000)).toBe(false)
    expect(podUiHostWorktreeSleepHeld(WT, false, true, 31_000)).toBe(false)
    endPodUiHostWindowSleep(WT)
    expect(podUiHostWorktreeSleepHeld(WT, false, true, 1_000)).toBe(false)
  })

  it('refuses only an automatic focus, and only in a one-app runtime', () => {
    expect(podUiHostRefusesAutomaticFocus(true, WT, true, true)).toBe(true)
    expect(podUiHostRefusesAutomaticFocus(false, WT, true, true)).toBe(false)
    expect(podUiHostRefusesAutomaticFocus(true, WT, true, false)).toBe(false)
    expect(podUiHostRefusesAutomaticFocus(true, WT, false, true)).toBe(false)
  })
})
