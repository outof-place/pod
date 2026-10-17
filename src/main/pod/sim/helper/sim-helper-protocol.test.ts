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
  SimHelperReport,
  simStreamNonce
} from './sim-helper-protocol'
import {
  SIM_HELPER_EVENTS,
  SIM_HELPER_STREAM_END_REASONS,
  parseSimHelperEvent
} from './sim-helper-events'
import { SimHelperXcode } from './sim-helper-xcode'

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
    ['axCached', SIM_HELPER_METHODS.ax.result],
    ['axTranslatorFallback', SIM_HELPER_METHODS.ax.result],
    ['axDegraded', SIM_HELPER_METHODS.ax.result],
    ['displayStatsStreaming', SIM_HELPER_METHODS.displayStats.result],
    ['startStream', SIM_HELPER_METHODS.startStream.result],
    ['stopStream', SIM_HELPER_METHODS.stopStream.result],
    ['settle', SIM_HELPER_METHODS.settle.result],
    ['settleWithMotion', SIM_HELPER_METHODS.settle.result],
    ['xcodeChosen', SimHelperXcode]
  ] as const)('keeps every key of the fixture result %s, optional ones too', (key, schema) => {
    // zod drops keys it does not know, so a key only one side has fails here.
    expect(schema.parse(fixture.results[key])).toEqual(fixture.results[key])
  })

  it('keeps every key of the events the helper sends, and reads each from its line', () => {
    expect(Object.keys(SIM_HELPER_EVENTS)).toEqual(Object.keys(fixture.events))
    for (const name of ['inputWedged', 'streamEnded'] as const) {
      expect(SIM_HELPER_EVENTS[name].parse(fixture.events[name])).toEqual(fixture.events[name])
      expect(parseSimHelperEvent({ event: name, params: fixture.events[name] })).toEqual({
        ok: true,
        event: { event: name, params: fixture.events[name] }
      })
    }
    expect([...SIM_HELPER_STREAM_END_REASONS]).toEqual(fixture.streamEndReasons)
    expect(
      parseSimHelperEvent({
        event: 'streamEnded',
        params: { ...fixture.events.streamEnded, nonce: 1953 }
      })
    ).toEqual({ ok: false, reason: 'an event of an unknown shape' })
  })

  it('asks ax for a fresh read in a field the helper decodes, and reads how each tree was read', () => {
    expect(SIM_HELPER_METHODS.ax.params.parse(fixture.requests.ax)).toEqual(fixture.requests.ax)
    const bases = ['ax', 'axCached', 'axTranslatorFallback'].map(
      (key) => SIM_HELPER_METHODS.ax.result.parse(fixture.results[key]).basis
    )
    expect(bases).toEqual(['parallel', 'cache', 'translator'])
    expect(
      SIM_HELPER_METHODS.ax.result.parse(fixture.results.axTranslatorFallback).fallbackReason
    ).toMatch(/lookup answered 0/)
    // A helper from before stage 3b sends neither field.
    expect(SIM_HELPER_METHODS.ax.result.parse(fixture.results.axDegraded).basis).toBeUndefined()
  })

  it('sends a live view its nonce as 16 hex digits the helper decodes, never zero', () => {
    expect(SIM_HELPER_METHODS.startStream.params.parse(fixture.requests.startStream)).toEqual(
      fixture.requests.startStream
    )
    expect(SIM_HELPER_METHODS.stopStream.params.parse(fixture.requests.stopStream)).toEqual(
      fixture.requests.stopStream
    )
    const { nonce: _nonce, ...withoutNonce } = fixture.requests.startStream
    expect(SIM_HELPER_METHODS.startStream.params.safeParse(withoutNonce).success).toBe(false)
    for (const nonce of ['0000000000000000', '9E3779B97F4A7C15', '9e3779b97f4a7c1']) {
      const params = { ...fixture.requests.startStream, nonce }
      expect(SIM_HELPER_METHODS.startStream.params.safeParse(params).success).toBe(false)
    }
    const made = new Set(Array.from({ length: 64 }, () => simStreamNonce()))
    expect(made.size).toBe(64)
    for (const nonce of made) {
      expect(nonce).toMatch(/^[0-9a-f]{16}$/)
    }
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
