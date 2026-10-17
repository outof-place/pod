// Fork-only (Pod): what pod-sim's display methods answer (protocol v1, sim-helper-protocol.ts):
// attaching, live views (startStream), settle and screenshots.
import { z } from 'zod'

export const SimHelperAttachResult = z.object({
  udid: z.string(),
  surface: z
    .object({ width: z.number().int(), height: z.number().int(), id: z.number().int() })
    .optional(),
  alreadyAttached: z.boolean()
})

/**
 * One live view's frame stream (startStream): the helper sends the device's IOSurface as a Mach
 * right, then one small message per presented frame, to the viewer that checked the rendezvous name
 * in (native/pod-sim-macos/Sources/CPodSimSurface/include/pod_sim_frame.h). Nothing goes out while
 * the screen is static. A full viewer queue drops a frame (a later one follows), never waits. A
 * stream whose viewer is gone is dropped at once and reported in a streamEnded event.
 */
export const SimHelperStreamStats = z.object({
  token: z.number().int(),
  framesSent: z.number().int(),
  framesDropped: z.number().int(),
  surfaceSends: z.number().int(),
  // The last frame number sent; it starts again at 1 with a surface message after a helper restart.
  seq: z.number().int()
})

export const SimHelperDisplayStats = z.object({
  udid: z.string(),
  seconds: z.number(),
  // One per presented frame; 0 while the screen is static.
  frameCallbacks: z.number().int(),
  surfaceCallbacks: z.number().int(),
  // Frames whose surface seed changed: what a viewer redraws.
  seedChanges: z.number().int(),
  // Time inside the frame callback over the last 512 frames, microseconds: the helper's own cost.
  callbackMicros: z
    .object({ n: z.number().int(), p50: z.number(), p95: z.number(), max: z.number() })
    .optional(),
  // The live views this display streams to.
  streams: z.array(SimHelperStreamStats).optional()
})

export const SimHelperStartStreamResult = z.object({
  udid: z.string(),
  token: z.number().int(),
  // Absent while the display has no surface yet; it follows in a surface message.
  surface: z
    .object({ width: z.number().int(), height: z.number().int(), id: z.number().int() })
    .optional(),
  // Pixels per point.
  scale: z.number()
})

// Points in the device's native (portrait) orientation, origin top left.
const PointRect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

/**
 * `settle`: settled once nothing but small regions (a caret, a spinner: at most smallPt points a
 * side, at most 4 of them) changed for windowMs and two accessibility reads inside that still window
 * agree. A screen that never settles answers settledWithMotion at timeoutMs with what kept moving,
 * never an error. `basis` says what decided: pixels and the tree, pixels alone (no translator or its
 * reads failed), or the tree alone (no live display; two reads a window apart).
 */
export const SimHelperSettleResult = z.object({
  udid: z.string(),
  outcome: z.enum(['settled', 'settledWithMotion']),
  waitedMs: z.number().int(),
  windowMs: z.number().int(),
  basis: z.enum(['pixelsAndTree', 'pixels', 'tree']),
  // Regions that kept the screen from settling, largest first; empty when settled.
  motion: z.array(PointRect),
  // Small regions still moving that settle allowed.
  ignored: z.array(PointRect),
  treeStable: z.boolean().optional(),
  fingerprint: z.string().optional(),
  alertSuspected: z.boolean().optional(),
  // Framebuffer hashes taken while settling, and their mean cost.
  hashes: z.number().int(),
  hashMicros: z.number(),
  treeReads: z.number().int()
})
export type SimHelperSettleResult = z.infer<typeof SimHelperSettleResult>

export const SimHelperScreenshot = z.object({
  path: z.string(),
  format: z.enum(['png', 'jpeg']),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  // `simctl`: `simctl io screenshot`, when the framebuffer path is off or failed (fallbackReason says why).
  source: z.enum(['surface', 'simctl']),
  ms: z.number().int(),
  fallbackReason: z.string().optional()
})
