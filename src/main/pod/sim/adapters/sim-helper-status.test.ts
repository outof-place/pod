import { describe, expect, it } from 'vitest'
import { SimHelperStatus } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimHelperReport } from '../helper/sim-helper-protocol'
import { simHelperStatusOf } from './sim-helper-status'

function report(
  known: boolean,
  verdicts: Partial<
    Record<'display' | 'screenshot' | 'hid' | 'ax', 'ok' | 'unsupported' | 'failed'>
  >
): SimHelperReport {
  const capability = (status: 'ok' | 'unsupported' | 'failed' = 'ok') => ({
    status,
    checked: 'symbols' as const
  })
  return {
    protocol: 1,
    helper: { version: '1.0.0', pid: 4242 },
    xcode: {
      developerDir: '/Applications/Xcode.app/Contents/Developer',
      source: 'xcode-select',
      build: '27A266a'
    },
    coreSimulator: { path: '/x', version: '1171.7', build: '1171.7' },
    simulatorKit: { path: '/y', version: '1010.2', build: '1010.2' },
    table: { known, source: 'bundled', forcedUnknown: !known },
    capabilities: {
      display: capability(verdicts.display),
      screenshot: capability(verdicts.screenshot),
      hid: capability(verdicts.hid),
      ax: capability(verdicts.ax)
    }
  }
}

describe('the helper’s report in the contract’s words', () => {
  it('maps hid to input and ax to accessibility on a build the table knows', () => {
    const status = simHelperStatusOf(report(true, { hid: 'ok', ax: 'failed' }))
    expect(SimHelperStatus.parse(status)).toEqual({
      state: 'ok',
      xcodeBuild: '27A266a',
      coreSimulator: '1171.7',
      simulatorKit: '1010.2',
      capabilities: {
        display: 'ok',
        screenshot: 'ok',
        input: 'ok',
        accessibility: 'unsupported',
        // Settled is a stable accessibility tree plus a quiet display: it needs both.
        settle: 'unsupported',
        record: 'unsupported'
      }
    })
  })

  it('marks what works on a build the table does not know as unverified', () => {
    const status = simHelperStatusOf(report(false, { display: 'unsupported' }))
    expect(status.state).toBe('unverified')
    expect(status.capabilities).toMatchObject({
      display: 'unsupported',
      screenshot: 'unverified',
      input: 'unverified',
      accessibility: 'unverified',
      settle: 'unsupported'
    })
  })

  it('reads no helper as absent, with nothing supported', () => {
    expect(simHelperStatusOf(null)).toEqual({
      state: 'absent',
      capabilities: {
        display: 'unsupported',
        screenshot: 'unsupported',
        input: 'unsupported',
        accessibility: 'unsupported',
        settle: 'unsupported',
        record: 'unsupported'
      }
    })
  })
})
