import { afterEach, describe, expect, it } from 'vitest'
import {
  beginPodUiHostWindowSleep,
  endPodUiHostWindowSleep,
  notePodUiHostWindowSleepSpawn,
  podUiHostRefusesAutomaticFocus,
  podUiHostWindowSleepSpawns,
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

  it("keeps the PTYs a worktree got during its window's sleep, for that sleep only", () => {
    notePodUiHostWindowSleepSpawn(WT, 'before', 500)
    beginPodUiHostWindowSleep(WT, 1_000)
    notePodUiHostWindowSleepSpawn(WT, 'woken', 1_200)
    notePodUiHostWindowSleepSpawn('repo::/other', 'elsewhere', 1_200)
    notePodUiHostWindowSleepSpawn(WT, 'too-late', 31_000)
    const spare = podUiHostWindowSleepSpawns(WT)
    expect([...spare]).toEqual(['woken'])
    // Live: what registers while the runtime's part runs counts too.
    notePodUiHostWindowSleepSpawn(WT, 'during-the-pass', 1_500)
    expect([...spare]).toEqual(['woken', 'during-the-pass'])
    // A new sleep starts from none.
    beginPodUiHostWindowSleep(WT, 40_000)
    expect(podUiHostWindowSleepSpawns(WT).size).toBe(0)
    notePodUiHostWindowSleepSpawn(WT, 'again', 40_100)
    endPodUiHostWindowSleep(WT)
    expect(podUiHostWindowSleepSpawns(WT).size).toBe(0)
  })
})
