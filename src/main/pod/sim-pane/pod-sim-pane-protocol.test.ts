import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parsePodUiHostClientLine, POD_UI_HOST_FEATURES } from '../ui-host/pod-ui-host-protocol'
import {
  isPodSimPaneMessage,
  POD_SIM_PANE_FEATURE,
  PodSimPaneServerMessage
} from './pod-sim-pane-protocol'

const fixture = z
  .object({
    feature: z.string(),
    client: z.array(z.record(z.string(), z.unknown())),
    // `sentAs`: what PodNative sends instead (clamped or cut), or null when it sends nothing.
    invalidClient: z.array(
      z.object({ name: z.string(), message: z.unknown(), sentAs: z.unknown() }).strict()
    ),
    server: z.array(z.unknown())
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'shared', 'pod-sim', 'fixtures', 'ui-host.json'),
        'utf8'
      )
    )
  )

const contractFeature = z
  .object({ uiHostFeature: z.string() })
  .parse(
    JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'shared', 'pod-sim', 'fixtures', 'contract.json'),
        'utf8'
      )
    )
  ).uiHostFeature

describe('the simulator tab on the ui-host socket', () => {
  it('is the feature PodNative looks for, which no runtime names before the live pane', () => {
    expect(POD_SIM_PANE_FEATURE).toBe(fixture.feature)
    expect(POD_SIM_PANE_FEATURE).toBe(contractFeature)
    expect(POD_UI_HOST_FEATURES).not.toContain(fixture.feature)
  })

  it('takes every client verb of the fixtures, as sent', () => {
    for (const message of fixture.client) {
      const parsed = parsePodUiHostClientLine(JSON.stringify(message))
      expect(parsed, JSON.stringify(message)).toEqual(message)
      expect(parsed && isPodSimPaneMessage(parsed)).toBe(true)
    }
  })

  for (const { name, message, sentAs } of fixture.invalidClient) {
    it(`refuses ${name}, and takes what PodNative sends instead`, () => {
      expect(parsePodUiHostClientLine(JSON.stringify(message))).toBeNull()
      if (sentAs !== null) {
        expect(parsePodUiHostClientLine(JSON.stringify(sentAs))).toEqual(sentAs)
      }
    })
  }

  it('answers in shapes PodNative decodes', () => {
    for (const message of fixture.server) {
      expect(PodSimPaneServerMessage.parse(message)).toEqual(message)
    }
  })

  it('claims no other verb of the socket', () => {
    for (const type of ['hello', 'quit', 'openSurface', 'secondInstance', 'browserAttach']) {
      expect(isPodSimPaneMessage({ type }), type).toBe(false)
    }
  })
})
