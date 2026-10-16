// Fork-only (Pod): the simulator tab's verbs on the one-app control socket, offered under the
// welcome's `simulator` feature: PodNative sends none to a runtime that does not list it, and an
// older PodNative never sends them. No runtime names the feature until the live pane lands (stage
// 8); until then the server ends a connection that sends one of these anyway. Frames do not travel here: the simulator helper sends the
// device's IOSurface over Mach to PodNative's rendezvous. These lines attach a tab to a lease, say
// whether it is on screen, carry a person's input and take the device over or give it back.
// PodNative mirrors them in PodRuntime/SimPaneProtocol.swift (outof-place/pod-native); the
// fixtures are src/shared/pod-sim/fixtures/ui-host.json.
import { z } from 'zod'
import { SIM_TYPE_MAX_CHARS } from '../../../shared/pod-sim/sim-call-limits'
import { SimLeaseId, SimUdid } from '../../../shared/pod-sim/sim-pool-snapshot'

export const POD_SIM_PANE_FEATURE = 'simulator'

// PodNative's launchd name for simulator frames, random per launch, apart from the browser's.
export const POD_SIM_RENDEZVOUS_PATTERN = /^codes\.pod\.native(\.dev)?\.sim\.[0-9a-f]{32}$/

// Input is in the screen's own unit square, origin top-left: PodNative needs no device sizes.
const Unit = z.number().finite().min(0).max(1)
const Delta = z.number().finite().min(-100_000).max(100_000)
const Token = z.number().int().min(1).max(2_147_483_647)

const Touch = z
  .object({
    kind: z.literal('touch'),
    phase: z.enum(['began', 'moved', 'ended', 'cancelled']),
    // One finger, or two for a pinch or rotate (the Option key in PodNative).
    points: z
      .array(z.object({ x: Unit, y: Unit }).strict())
      .min(1)
      .max(2),
    edge: z.enum(['left', 'right', 'top', 'bottom']).optional()
  })
  .strict()

const Key = z
  .object({
    kind: z.literal('key'),
    action: z.enum(['down', 'up']),
    // A USB HID usage on the keyboard page (0x07), as the helper sends it to the device.
    usage: z.number().int().min(0).max(0xffff),
    modifiers: z.array(z.enum(['shift', 'control', 'option', 'command', 'capsLock'])).max(5)
  })
  .strict()

// Code points, as zod counts them; PodNative cuts longer text before it sends it.
const Text = z
  .object({ kind: z.literal('text'), text: z.string().min(1).max(SIM_TYPE_MAX_CHARS) })
  .strict()

const Button = z
  .object({
    kind: z.literal('button'),
    button: z.enum(['home', 'lock', 'siri', 'volumeUp', 'volumeDown'])
  })
  .strict()

const Scroll = z
  .object({ kind: z.literal('scroll'), x: Unit, y: Unit, deltaX: Delta, deltaY: Delta })
  .strict()

export const PodSimInputEvent = z.discriminatedUnion('kind', [Touch, Key, Text, Button, Scroll])
export type PodSimInputEvent = z.infer<typeof PodSimInputEvent>

const Rendezvous = z
  .object({
    type: z.literal('simRendezvous'),
    service: z.string().regex(POD_SIM_RENDEZVOUS_PATTERN)
  })
  .strict()
const Attach = z
  .object({ type: z.literal('simAttach'), leaseId: SimLeaseId, token: Token })
  .strict()
const Detach = z.object({ type: z.literal('simDetach'), leaseId: SimLeaseId }).strict()
// Only a tab on screen gets frames.
const Pane = z
  .object({ type: z.literal('simPane'), leaseId: SimLeaseId, visible: z.boolean() })
  .strict()
const Input = z
  .object({ type: z.literal('simInput'), leaseId: SimLeaseId, event: PodSimInputEvent })
  .strict()
// `take`: the agent's input verbs answer held_by_human until `giveBack` or two idle minutes.
const Takeover = z
  .object({
    type: z.literal('simTakeover'),
    leaseId: SimLeaseId,
    action: z.enum(['take', 'giveBack'])
  })
  .strict()

/** Every simulator verb, for the socket's discriminated union of client messages. */
export const POD_SIM_PANE_CLIENT_MESSAGES = [
  Rendezvous,
  Attach,
  Detach,
  Pane,
  Input,
  Takeover
] as const

export type PodSimPaneClientMessage =
  | z.infer<typeof Rendezvous>
  | z.infer<typeof Attach>
  | z.infer<typeof Detach>
  | z.infer<typeof Pane>
  | z.infer<typeof Input>
  | z.infer<typeof Takeover>

export const PodSimPaneServerMessage = z.discriminatedUnion('type', [
  // Frames for this lease now go to the rendezvous, tagged with the attach's token.
  z.object({
    type: z.literal('simAttached'),
    leaseId: SimLeaseId,
    token: Token,
    udid: SimUdid,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive()
  }),
  z.object({
    type: z.literal('simAttachFailed'),
    leaseId: SimLeaseId,
    reason: z.enum(['unavailable', 'notLeased', 'helperUnsupported', 'deviceNotBooted']),
    message: z.string().max(1024)
  }),
  // The tab shows "ended" for leaseEnded; the others may attach again.
  z.object({
    type: z.literal('simDetached'),
    leaseId: SimLeaseId,
    reason: z.enum(['leaseEnded', 'deviceLost', 'helperExited', 'detached'])
  }),
  z.object({
    type: z.literal('simTakeoverState'),
    leaseId: SimLeaseId,
    driver: z.enum(['human', 'agent']),
    since: z.number().int().nonnegative().optional(),
    reason: z.enum(['giveBack', 'idle', 'leaseEnded']).optional()
  })
])
export type PodSimPaneServerMessage = z.infer<typeof PodSimPaneServerMessage>

export function isPodSimPaneMessage(message: { type: string }): message is PodSimPaneClientMessage {
  return message.type.startsWith('sim')
}
