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
  SimHelperHidAction,
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
    ['screenshotSimctl', SIM_HELPER_METHODS.screenshot.result],
    ['selftestInput', SimHelperReport],
    ['selftestAxUnknownTranslator', SimHelperReport],
    ['hidTap', SIM_HELPER_METHODS.hid.result],
    ['hidText', SIM_HELPER_METHODS.hid.result],
    ['hidPasteAlert', SIM_HELPER_METHODS.hid.result],
    ['hidDegraded', SIM_HELPER_METHODS.hid.result],
    ['ax', SIM_HELPER_METHODS.ax.result],
    ['axDegraded', SIM_HELPER_METHODS.ax.result]
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
    const input = SimHelperReport.parse(fixture.results.selftestInput)
    expect([input.capabilities.hid.status, input.capabilities.ax.status]).toEqual(['ok', 'ok'])
    expect(input.macOS?.build).toBe('26A434')
    // ax is keyed by the translator's build too: an unlisted one turns ax alone unsupported.
    const newTranslator = SimHelperReport.parse(fixture.results.selftestAxUnknownTranslator)
    expect([newTranslator.capabilities.hid.status, newTranslator.capabilities.ax.status]).toEqual([
      'ok',
      'unsupported'
    ])
    expect(SIM_HELPER_METHODS.hid.result.parse(fixture.results.hidTap).frameAfterMs).toBe(26.5)
    const ax = SIM_HELPER_METHODS.ax.result.parse(fixture.results.ax)
    expect(ax.nodes.map((node) => node.label)).toEqual(['Search bookings', 'October', 'More'])
    expect(ax.shown + ax.omitted).toBe(ax.total)
    expect(ax.screen.orientation).toBe('portrait')
    expect(SIM_HELPER_METHODS.ax.result.parse(fixture.results.axDegraded).degraded).toMatch(/^ax: /)
  })

  it('keeps every hid action the helper decodes', () => {
    const actions = [
      { kind: 'tap', x: 201, y: 82 },
      { kind: 'longPress', x: 201, y: 82, durationMs: 800 },
      { kind: 'swipe', from: { x: 201, y: 700 }, to: { x: 201, y: 200 }, edge: 'bottom' },
      { kind: 'drag', from: { x: 50, y: 400 }, to: { x: 350, y: 400 }, pressMs: 600 },
      { kind: 'pinch', centre: { x: 201, y: 437 }, fromSpan: 100, toSpan: 300, angle: 90 },
      { kind: 'touch', phase: 'move', points: [{ x: 10, y: 20 }] },
      { kind: 'text', text: 'zażółć gęślą jaźń', via: 'paste' },
      { kind: 'key', key: 'return', modifiers: ['command'], phase: 'press' },
      { kind: 'button', button: 'lock', holdMs: 100 }
    ]
    for (const action of actions) {
      expect(SimHelperHidAction.parse(action)).toEqual(action)
    }
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
