// Fork-only (Pod): the lines pod-sim sends unasked (protocol v1): `{"event": name, "params": {...}}`
// with no id, only after hello. The runtime acts on the ones it knows and logs the rest.
import { z } from 'zod'
import { SimHelperStreamNonce } from './sim-helper-protocol'
import { simHelperUnavailable, type SimHelperFailure } from './sim-helper-result'

/**
 * `inputWedged`: a device's hid queue was given up on because a call has been stuck in a private
 * call past its deadline. The helper dropped that device's input connection and runs its next call
 * afresh; other devices never noticed. Each abandoned queue keeps one helper thread stuck, so with
 * `recycleAdvised` the runtime replaces the helper (with its restart backoff).
 */
export const SimHelperInputWedged = z.object({
  udid: z.string(),
  stuckMs: z.number().int(),
  // Calls answered `wedged` without being sent.
  dropped: z.number().int(),
  // Queues given up on since this helper started.
  abandoned: z.number().int(),
  recycleAdvised: z.boolean()
})

/**
 * Why a live view ended without a stopStream, as pod-sim says it (StreamEndReason in the helper):
 * viewerGone, the viewer's port is dead (forget the view); deviceShutDown, start it again only after
 * a boot; deviceRebooted, call startStream again; detached, detachDisplay ended it (a pool reset),
 * call startStream again to keep showing the device.
 */
export const SIM_HELPER_STREAM_END_REASONS = [
  'viewerGone',
  'deviceShutDown',
  'deviceRebooted',
  'detached'
] as const

/**
 * `streamEnded`: one live view ended without a stopStream. `nonce` names its generation, so a view
 * started again under the same token is not mistaken for it. The runtime reports `helperRestart`
 * itself, never the helper: the replacement helper refused to stream that view again (ui-host
 * publishes simDetached{reason: 'helperExited'} for it).
 */
export const SimHelperStreamEnded = z.object({
  udid: z.string(),
  token: z.number().int(),
  nonce: SimHelperStreamNonce,
  reason: z.enum([...SIM_HELPER_STREAM_END_REASONS, 'helperRestart'])
})
export type SimHelperStreamEnded = z.infer<typeof SimHelperStreamEnded>

/** Lines the helper sends unasked: `{"event": name, "params": {...}}`, no id. */
export const SIM_HELPER_EVENTS = {
  inputWedged: SimHelperInputWedged,
  streamEnded: SimHelperStreamEnded
} as const
export type SimHelperEvent = {
  [E in keyof typeof SIM_HELPER_EVENTS]: {
    event: E
    params: z.infer<(typeof SIM_HELPER_EVENTS)[E]>
  }
}[keyof typeof SIM_HELPER_EVENTS]

export const SimHelperEventFrame = z.object({
  event: z.string(),
  params: z.record(z.string(), z.unknown())
})

type Parsed = { ok: true; event: SimHelperEvent } | { ok: false; reason: string }
const UNKNOWN_SHAPE: Parsed = { ok: false, reason: 'an event of an unknown shape' }

/** A known event from a parsed line, or why it is not one. */
export function parseSimHelperEvent(parsed: unknown): Parsed {
  const frame = SimHelperEventFrame.safeParse(parsed)
  if (!frame.success) {
    return { ok: false, reason: 'an unknown event' }
  }
  const { event, params } = frame.data
  switch (event) {
    case 'inputWedged': {
      const known = SimHelperInputWedged.safeParse(params)
      return known.success ? { ok: true, event: { event, params: known.data } } : UNKNOWN_SHAPE
    }
    case 'streamEnded': {
      const known = SimHelperStreamEnded.safeParse(params)
      return known.success ? { ok: true, event: { event, params: known.data } } : UNKNOWN_SHAPE
    }
    default:
      return { ok: false, reason: 'an unknown event' }
  }
}

/**
 * The runtime's answer to an event of its current helper: a line in its log, then its action (an
 * ended view is forgotten so no restart streams it again; a helper that advises it is replaced),
 * then the listener (whose throw is logged, never thrown). An abandoned hid queue keeps a helper
 * thread stuck; a fresh process frees them, and the restart backoff spaces out a device that keeps
 * wedging.
 */
export function actOnSimHelperEvent(
  event: SimHelperEvent,
  hooks: {
    log: (message: string) => void
    recycle: (failure: SimHelperFailure) => void
    forgetView: (view: SimHelperStreamEnded) => void
    listener?: (event: SimHelperEvent) => void
  }
): void {
  if (event.event === 'streamEnded') {
    const { udid, token, reason } = event.params
    hooks.log(`live view ${udid} ${token} ended: ${reason}`)
    hooks.forgetView(event.params)
  } else {
    const { udid, stuckMs, dropped, abandoned, recycleAdvised } = event.params
    hooks.log(
      `hid of ${udid} was stuck ${stuckMs} ms in a private call: its input connection was reset and ${dropped} queued calls answered wedged`
    )
    if (recycleAdvised) {
      const failure = simHelperUnavailable('wedged', `${abandoned} threads stuck in private calls`)
      hooks.log(`${failure.message}; recycling the helper`)
      hooks.recycle(failure)
    }
  }
  try {
    hooks.listener?.(event)
  } catch (error) {
    hooks.log(`onEvent threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}
