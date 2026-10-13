import { describe, expect, it } from 'vitest'
import {
  getProcessStartedAtMs,
  selfReportedStartMatches,
  startTimeMatches
} from './daemon-process-start-time'

const REPORTED = 1_791_883_530_108

describe('selfReportedStartMatches', () => {
  it.each([
    // Live daemon 1047 (2026-10-13): the kernel start was 3.52 s before its own Date.now() - uptime.
    ['3.5 s earlier', -3_500, true],
    ['29 s earlier', -29_000, true],
    ['31 s earlier', -31_000, false],
    ['1.4 s later', 1_400, true],
    ['2 s later (a reused pid)', 2_000, false],
    ['1 h later (a reused pid)', 3_600_000, false]
  ])('the OS start %s than reported: %s', (_label, offsetMs, matches) => {
    expect(selfReportedStartMatches(REPORTED + offsetMs, REPORTED)).toBe(matches)
  })

  it('fails open when either side is null', () => {
    expect(selfReportedStartMatches(null, REPORTED)).toBe(true)
    expect(selfReportedStartMatches(REPORTED, null)).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('startTimeMatches', () => {
  it('accepts a reported start that lags the OS start, and rejects one that leads it', () => {
    const osStart = getProcessStartedAtMs(process.pid)
    expect(osStart).not.toBeNull()
    expect(startTimeMatches(process.pid, osStart! + 3_500)).toBe(true)
    expect(startTimeMatches(process.pid, osStart! + 31_000)).toBe(false)
    expect(startTimeMatches(process.pid, osStart! - 2_000)).toBe(false)
  })
})
