// Fork-only (Pod): config/scripts/ci-unit-retry-summary-reporter.mjs.
import { describe, expect, it } from 'vitest'
import UnitRetrySummaryReporter from './ci-unit-retry-summary-reporter.mjs'

function testCase(name, retryCount, state) {
  return {
    fullName: name,
    module: { moduleId: '/repo/src/main/a.test.ts' },
    diagnostic: () => ({ retryCount }),
    result: () => ({ state })
  }
}

function run(cases, shard) {
  const written = []
  const reporter = new UnitRetrySummaryReporter({
    write: (text) => written.push(text),
    log: () => {}
  })
  reporter.onInit({ config: { root: '/repo', shard } })
  for (const entry of cases) {
    reporter.onTestCaseResult(entry)
  }
  reporter.onTestRunEnd()
  return written.join('')
}

describe('unit retry summary reporter', () => {
  it('lists each retried test with its outcome', () => {
    const summary = run(
      [
        testCase('a > flaky', 1, 'passed'),
        testCase('a > steady', 0, 'passed'),
        testCase('a > broken', 1, 'failed')
      ],
      { index: 2, count: 5 }
    )
    expect(summary).toBe(
      [
        'Unit tests 2/5: 2 test(s) needed a retry.',
        '- passed on retry (1): src/main/a.test.ts > a > flaky',
        '- failed (1): src/main/a.test.ts > a > broken',
        ''
      ].join('\n')
    )
  })

  it('says so when no test needed a retry', () => {
    expect(run([testCase('a > steady', 0, 'passed')])).toBe('Unit tests: no test needed a retry.\n')
  })

  it('skips a test that never ran', () => {
    const notRun = { ...testCase('a > skipped', 0, 'skipped'), diagnostic: () => undefined }
    expect(run([notRun])).toBe('Unit tests: no test needed a retry.\n')
  })
})
