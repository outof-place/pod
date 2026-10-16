import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SIM_HELPER_CAPABILITIES,
  SIM_HELPER_CHECK_LEVELS,
  SIM_HELPER_DEADLINES_MS,
  SIM_HELPER_ERROR_CODES,
  SIM_HELPER_MAX_FRAME_BYTES,
  SIM_HELPER_METHODS,
  SIM_HELPER_PROTOCOL_VERSION,
  SIM_HELPER_TOKEN_ENV,
  SimHelperReport
} from './sim-helper-protocol'

// The helper's Swift tests decode the same file (native/pod-sim-macos/Tests/PodSimKitTests).
const fixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../../native/pod-sim-macos/Fixtures/protocol-v1.json'),
    'utf8'
  )
)

describe('pod-sim protocol v1 as the runtime reads it', () => {
  it('names the same version, frame limit, token variable, error codes and capabilities as the helper', () => {
    expect(SIM_HELPER_PROTOCOL_VERSION).toBe(fixture.protocol)
    expect(SIM_HELPER_MAX_FRAME_BYTES).toBe(fixture.maxFrameBytes)
    expect(SIM_HELPER_TOKEN_ENV).toBe(fixture.tokenEnv)
    expect([...SIM_HELPER_ERROR_CODES]).toEqual(fixture.errorCodes)
    expect([...SIM_HELPER_CAPABILITIES]).toEqual(fixture.capabilities)
    expect(['hello', ...Object.keys(SIM_HELPER_METHODS)]).toEqual(fixture.methods)
    expect([...SIM_HELPER_CHECK_LEVELS]).toEqual(fixture.checkLevels)
  })

  it('budgets each call from the same per-method deadlines the helper enforces', () => {
    expect(SIM_HELPER_DEADLINES_MS).toEqual(fixture.deadlinesMs)
  })

  it.each([
    ['hello', SimHelperReport],
    ['selftestUnknownBuild', SimHelperReport],
    ['selftestDevice', SimHelperReport],
    ['selftestStaticScreen', SimHelperReport],
    ['attachDisplay', SIM_HELPER_METHODS.attachDisplay.result],
    ['displayStats', SIM_HELPER_METHODS.displayStats.result],
    ['screenshot', SIM_HELPER_METHODS.screenshot.result],
    ['screenshotSimctl', SIM_HELPER_METHODS.screenshot.result]
  ] as const)('keeps every key of the fixture result %s, optional ones too', (key, schema) => {
    // zod drops keys it does not know, so a key only one side has fails here.
    expect(schema.parse(fixture.results[key])).toEqual(fixture.results[key])
  })

  it('decodes the helper results the fixture freezes', () => {
    expect(SimHelperReport.parse(fixture.results.hello).capabilities.display.status).toBe('ok')
    const unknown = SimHelperReport.parse(fixture.results.selftestUnknownBuild)
    expect(unknown.table.known).toBe(false)
    expect(unknown.fallbacks?.screenshot.status).toBe('ok')
    expect(
      SIM_HELPER_METHODS.attachDisplay.result.parse(fixture.results.attachDisplay).surface?.width
    ).toBe(1206)
    expect(
      SIM_HELPER_METHODS.displayStats.result.parse(fixture.results.displayStats).frameCallbacks
    ).toBe(1123)
    expect(SIM_HELPER_METHODS.screenshot.result.parse(fixture.results.screenshot).source).toBe(
      'surface'
    )
  })

  it('every error an exchange expects is one the runtime knows', () => {
    const expected = fixture.exchanges.flatMap((exchange: { expect: { error?: string }[] }) =>
      exchange.expect.flatMap((reply) => (reply.error ? [reply.error] : []))
    )
    expect(expected.length).toBeGreaterThan(0)
    for (const code of expected) {
      expect(SIM_HELPER_ERROR_CODES).toContain(code)
    }
  })
})
