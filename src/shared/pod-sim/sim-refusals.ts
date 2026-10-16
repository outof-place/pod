// Fork-only (Pod): why a sim call did not happen, in words an agent acts on. Every refusal names
// the exact next command, and travels as the RPC failure `{ code, message, data: { refusal } }`.
// `waitable` refusals end once the holder waits (`podx sim wait --mine`). `release` never refuses
// for a lease that is gone or ended: it answers `released: false` (sim-results.ts).
import { z } from 'zod'
import { SIM_WAITER_ABANDON_S, SIM_WAITING_LIST_MAX } from './sim-call-limits'
import { SimHolder } from './sim-holder'
import { SimBuildId } from './sim-pool-snapshot'

export const SIM_REFUSAL_CODES = [
  'not_leased',
  'lease_waiting',
  'lease_expired',
  'held_by_human',
  'held_by_other',
  'device_busy',
  'device_down',
  'build_failed',
  'no_worktree',
  'no_holder',
  'no_recipe',
  'bad_recipe',
  'unknown_app',
  'ambiguous_app',
  'unavailable',
  'capability_unavailable',
  'element_not_found',
  'element_ambiguous',
  'element_offscreen',
  'path_outside_worktree',
  'wait_timeout'
] as const
export type SimRefusalCode = (typeof SIM_REFUSAL_CODES)[number]

const Text = z.string().min(1).max(1024)
const Root = z.string().min(1).max(4096)
// A `podx sim` verb as typed, with its mode: `tap`, `wait --mine`, `record stop`.
const Verb = z.string().regex(/^[a-z]{2,16}( [a-z-]{1,16})?$/)
const AppIds = z.array(z.string().min(1).max(64)).min(1)
const Query = z.object({ by: z.enum(['label', 'id', 'index']), text: Text }).strict()

const input = <Code extends SimRefusalCode, Shape extends z.ZodRawShape>(
  code: Code,
  shape: Shape
) => z.object({ code: z.literal(code), ...shape }).strict()

/** What the runtime knows when it refuses; simRefusal turns it into the agent's words. */
export const SimRefusalInput = z.discriminatedUnion('code', [
  input('not_leased', {
    worktreeRoot: Root,
    verb: Verb,
    // This holder's leases for other worktrees (a subagent after `cd`, a flow in another tree).
    heldElsewhere: z
      .array(z.object({ worktreeRoot: Root, device: Text }).strict())
      .max(SIM_WAITING_LIST_MAX)
      .optional()
  }),
  input('lease_waiting', { position: z.number().int().positive() }),
  input('lease_expired', {
    reason: z.enum(['idleForWaiter', 'memoryBrake', 'abandoned', 'deviceLost'])
  }),
  input('held_by_human', {}),
  input('held_by_other', { device: Text, holder: SimHolder, worktreeRoot: Root }),
  input('device_busy', { state: z.enum(['preparing', 'booting', 'resetting', 'releasing']) }),
  // The lease is live but its device failed or went away outside Pod: Pod brings it back.
  input('device_down', {
    device: Text,
    state: z.enum(['failed', 'lost']),
    problem: Text.optional()
  }),
  // The dev-client build the lease waited for failed, which ended the lease.
  input('build_failed', {
    buildId: SimBuildId,
    logPath: Root,
    app: z.string().min(1).max(64).optional()
  }),
  input('no_worktree', {}),
  input('no_holder', {}),
  input('no_recipe', { worktreeRoot: Root }),
  input('bad_recipe', { path: Text, problem: Text }),
  input('unknown_app', { app: Text, apps: AppIds }),
  input('ambiguous_app', { apps: AppIds }),
  input('unavailable', { problem: Text }),
  input('capability_unavailable', { verb: Text, capability: Text, fallback: Text.optional() }),
  input('element_not_found', { query: Query }),
  input('element_ambiguous', {
    query: Query,
    indexes: z.array(z.number().int().nonnegative()).min(2)
  }),
  input('element_offscreen', { query: Query, direction: z.enum(['up', 'down', 'left', 'right']) }),
  input('path_outside_worktree', {
    verb: z.enum(['screenshot', 'record']),
    worktreeRoot: Root,
    // Pod's evidence folder, outside every worktree, where output goes without --out.
    evidenceDir: Root
  }),
  input('wait_timeout', {
    condition: z.object({ by: z.enum(['text', 'gone']), text: Text }).strict(),
    seconds: z.number().positive()
  })
])
export type SimRefusalInput = z.infer<typeof SimRefusalInput>

export const SimRefusal = z.object({
  code: z.enum(SIM_REFUSAL_CODES),
  message: z.string().min(1).max(2048),
  next: z.string().min(1).max(1024),
  waitable: z.boolean(),
  holder: SimHolder.optional()
})
export type SimRefusal = z.infer<typeof SimRefusal>

const WAIT_MINE = 'podx sim wait --mine'
const LEASE = 'podx sim lease'
const STATE = 'podx sim state'

/** How a holder reads in a sentence: `claude 41233`, `terminal term_7f3a`. */
export function simHolderLabel(holder: SimHolder): string {
  const name = holder.name ? ` ${holder.name}` : ''
  switch (holder.kind) {
    case 'agent':
      return `${holder.agent} ${holder.pid}${name}`
    case 'agentSession':
      return `${holder.agent ?? 'agent'} session ${holder.sessionId?.slice(0, 8)}${name}`
    case 'terminal':
      return `terminal ${holder.terminalHandle}${name}`
    case 'process':
      return `process ${holder.pid}${name}`
    case 'human':
      return holder.name ?? 'a person'
  }
}

const EXPIRED: Record<Extract<SimRefusalInput, { code: 'lease_expired' }>['reason'], string> = {
  idleForWaiter: 'it sat idle while another agent waited',
  memoryBrake: 'the Mac ran short of memory',
  abandoned: `it stayed queued ${SIM_WAITER_ABANDON_S / 60} minutes with no lease or wait --mine call, so its place went to the next agent`,
  deviceLost: 'its simulator went away and could not be brought back'
}

function element(query: z.infer<typeof Query>): string {
  return query.by === 'index' ? `index ${query.text}` : `${query.by} "${query.text}"`
}

function words(refusal: SimRefusalInput): { text: string; next: string } {
  switch (refusal.code) {
    case 'not_leased': {
      const [other, ...more] = refusal.heldElsewhere ?? []
      if (!other) {
        return { text: `You hold no simulator for ${refusal.worktreeRoot}.`, next: LEASE }
      }
      const others = more.length > 0 ? ` (and ${more.length} more)` : ''
      const selector = `--worktree path:${other.worktreeRoot}`
      return {
        text: `You hold no simulator for ${refusal.worktreeRoot}, but you hold ${other.device} for ${other.worktreeRoot}${others}. Repeat your command with ${selector} to use it, or run ${LEASE} for a device of this worktree's own.`,
        next: `podx sim ${refusal.verb} ${selector}`
      }
    }
    case 'lease_waiting':
      return {
        text: `You are queued for a simulator (position ${refusal.position}).`,
        next: WAIT_MINE
      }
    case 'lease_expired':
      return { text: `Your simulator lease ended: ${EXPIRED[refusal.reason]}.`, next: LEASE }
    case 'held_by_human':
      return {
        text: 'Someone took over this simulator in Pod; input waits until it is given back.',
        next: WAIT_MINE
      }
    case 'held_by_other':
      return {
        text: `${refusal.device} is leased by ${simHolderLabel(refusal.holder)} in ${refusal.worktreeRoot}.`,
        next: LEASE
      }
    case 'device_busy':
      return { text: `Your simulator is ${refusal.state}.`, next: WAIT_MINE }
    case 'device_down':
      return {
        text:
          refusal.state === 'lost'
            ? `${refusal.device} was shut down or deleted outside Pod; Pod brings it back for your lease.`
            : `${refusal.device} failed${refusal.problem ? ` (${refusal.problem})` : ''}; Pod restarts it for your lease.`,
        next: WAIT_MINE
      }
    case 'build_failed':
      return {
        text: `The dev-client build ${refusal.buildId} failed and ended your lease; its log is ${refusal.logPath}. Fix the build, then`,
        next: refusal.app ? `${LEASE} --app ${refusal.app}` : LEASE
      }
    case 'no_worktree':
      return {
        text: 'This directory is in no worktree or Pod workspace.',
        next: `${LEASE} --worktree path:<root>`
      }
    case 'no_holder':
      return {
        text: 'No agent, Pod terminal or shell above this call can hold a lease; name a holder for it.',
        next: `${LEASE} --holder <name>`
      }
    case 'no_recipe':
      return {
        text: `No simulators recipe in ${refusal.worktreeRoot}/orca.yaml; add a simulators: section first.`,
        next: LEASE
      }
    case 'bad_recipe':
      return { text: `orca.yaml ${refusal.path}: ${refusal.problem}. Fix it, then`, next: LEASE }
    case 'unknown_app':
      return {
        text: `No app named ${refusal.app} in the simulators recipe (apps: ${refusal.apps.join(', ')}).`,
        next: `${LEASE} --app ${refusal.apps[0]}`
      }
    case 'ambiguous_app':
      return {
        text: `The simulators recipe has several apps (${refusal.apps.join(', ')}).`,
        next: `${LEASE} --app ${refusal.apps[0]}`
      }
    case 'unavailable':
      return { text: `Simulators are off: ${refusal.problem}`, next: 'podx sim status' }
    case 'capability_unavailable':
      return {
        text: `podx sim ${refusal.verb} is unavailable here: ${refusal.capability} failed the helper's self-test on this Xcode build.`,
        next: refusal.fallback ?? 'podx sim status'
      }
    case 'element_not_found':
      return { text: `No element with ${element(refusal.query)} is on screen.`, next: STATE }
    case 'element_ambiguous':
      return {
        text: `${refusal.indexes.length} elements have ${element(refusal.query)} (indexes ${refusal.indexes.join(', ')}).`,
        next: `podx sim tap --index ${refusal.indexes[0]}`
      }
    case 'element_offscreen':
      return {
        text: `The element with ${element(refusal.query)} is off screen.`,
        next: `podx sim scroll --direction ${refusal.direction}`
      }
    case 'path_outside_worktree':
      return {
        text: `--out must be inside ${refusal.worktreeRoot} or Pod's evidence folder; without --out it goes to ${refusal.evidenceDir}, which no git add picks up.`,
        next: refusal.verb === 'screenshot' ? 'podx sim screenshot' : 'podx sim record start'
      }
    case 'wait_timeout':
      return {
        text:
          refusal.condition.by === 'text'
            ? `Text "${refusal.condition.text}" did not appear within ${refusal.seconds} s.`
            : `Text "${refusal.condition.text}" was still on screen after ${refusal.seconds} s.`,
        next: STATE
      }
  }
}

const WAITABLE: ReadonlySet<SimRefusalCode> = new Set([
  'lease_waiting',
  'held_by_human',
  'device_busy',
  'device_down'
])

export function simRefusal(refusal: SimRefusalInput): SimRefusal {
  const { text, next } = words(refusal)
  // A sentence that ends in "then" (bad_recipe, build_failed) runs on into the command.
  const glue = text.endsWith('then') ? ' run: ' : ' Run: '
  return {
    code: refusal.code,
    message: `${text}${glue}${next}`,
    next,
    waitable: WAITABLE.has(refusal.code),
    ...(refusal.code === 'held_by_other' ? { holder: refusal.holder } : {})
  }
}
