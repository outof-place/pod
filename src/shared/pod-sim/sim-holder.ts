// Fork-only (Pod): who holds a simulator lease and how a sim call finds its lease.
//
// Lease key = (holder, worktree root). The root is the --worktree root, else the git toplevel of
// the caller's cwd, else the Pod folder workspace holding cwd, else ORCA_WORKTREE_PATH: cwd wins
// over ORCA_WORKTREE_*, so a subagent working in another worktree gets a lease of its own. Every
// root is a realpath, and the runtime resolves the lease's worktreeId from that realpath, never
// from the caller's ORCA_WORKTREE_ID. The holder is the nearest agent CLI up the caller's process
// tree, else the agent session Pod's agent-status store has for the pane, else the pane itself,
// else (outside Pod) the process that ran podx; never the podx process, which ends with the call.
// `--holder <name>` splits one holder into several, so parallel flows in one agent process (and
// subagents, which share it) each hold their own lease; with nothing else to anchor it, the name
// alone holds the lease as a `human` holder (a person, or a script that names itself).
//
// Liveness (stage 4 checks it): agent and process by pid plus start time (within 2 s, as
// claude-acc does); agentSession by the agent-status store; terminal by the pane still open;
// human never exits by liveness (it ends by release, revocation or abandonment).
// A lease ends on `exited` only: `unverifiable` keeps it.
import { z } from 'zod'

/** `--holder`: short, and never `@` or `/`, which the key and the holder id use. */
export const SIM_HOLDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

// The simulator host is macOS, so paths are POSIX.
export const SimAbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'must be an absolute path')

const HolderName = z.string().regex(SIM_HOLDER_NAME_PATTERN)
// Anything that may end up in a holder id: no `@` (the key's separator) and no whitespace.
const KeyPart = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^@\s]+$/)
const Handle = KeyPart(256)
const AgentName = KeyPart(64)
const SessionId = KeyPart(256)
const Pid = z.number().int().positive()
// Seconds since the epoch, as proc_pidinfo and claude-acc's lease files give it.
const StartedAt = z.number().int().nonnegative()

/**
 * What a sim call says about itself: the CLI fills it from its own process and environment. Hints,
 * not authority (the runtime resolves the key itself), so a newer CLI's extra hint is dropped,
 * never refused.
 */
export const SimCaller = z.object({
  cwd: SimAbsolutePath,
  pid: Pid,
  terminalHandle: Handle.optional(),
  worktreePath: SimAbsolutePath.optional(),
  holder: HolderName.optional(),
  // A worktree selector, as other commands take it (`path:<root>`); for callers outside a Pod
  // terminal, or to reach a lease held for another worktree.
  worktree: z.string().min(1).max(4096).optional()
})
export type SimCaller = z.infer<typeof SimCaller>

export const SIM_HOLDER_KINDS = ['agent', 'agentSession', 'terminal', 'process', 'human'] as const
export type SimHolderKind = (typeof SIM_HOLDER_KINDS)[number]

export type SimHolderLiveness = 'live' | 'exited' | 'unverifiable'

const REQUIRED_BY_KIND = {
  agent: ['agent', 'pid', 'startedAt'],
  agentSession: ['sessionId'],
  terminal: ['terminalHandle'],
  process: ['pid', 'startedAt'],
  human: ['name']
} as const

// Loose: leases are persisted (sim-registry.ts), and a newer runtime's field survives a rewrite.
export const SimHolder = z
  .looseObject({
    kind: z.enum(SIM_HOLDER_KINDS),
    // The holder half of the lease key: `agent:<cli>:<pid>:<startedAt>`, `session:<id>`,
    // `terminal:<handle>` or `process:<pid>:<startedAt>`, then `/<name>` for --holder; or
    // `human:<name>`.
    id: KeyPart(512),
    name: HolderName.optional(),
    agent: AgentName.optional(),
    pid: Pid.optional(),
    startedAt: StartedAt.optional(),
    sessionId: SessionId.optional(),
    terminalHandle: Handle.optional()
  })
  .superRefine((holder, context) => {
    for (const field of REQUIRED_BY_KIND[holder.kind]) {
      if (holder[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `a ${holder.kind} holder needs ${field}`
        })
      }
    }
  })
export type SimHolder = z.infer<typeof SimHolder>

const ProcessFact = z.object({ pid: Pid, startedAt: StartedAt }).strict()

/** What the runtime finds out about a caller before it resolves the lease key. */
export const SimCallerFactsSchema = z
  .object({
    holderName: HolderName.nullable(),
    worktreeFlagRoot: SimAbsolutePath.nullable(),
    cwdGitToplevel: SimAbsolutePath.nullable(),
    cwdWorkspaceRoot: SimAbsolutePath.nullable(),
    envWorktreePath: SimAbsolutePath.nullable(),
    agent: z.object({ agent: AgentName, pid: Pid, startedAt: StartedAt }).strict().nullable(),
    paneAgentSession: z.object({ sessionId: SessionId, agent: AgentName }).strict().nullable(),
    terminalHandle: Handle.nullable(),
    // The process that ran podx (its parent), never podx itself.
    parent: ProcessFact.nullable()
  })
  .strict()
export type SimCallerFacts = z.infer<typeof SimCallerFactsSchema>

export type SimLeaseKeyResolution =
  | { ok: true; key: string; worktreeRoot: string; holder: SimHolder }
  | { ok: false; refusal: 'no_worktree' | 'no_holder' }

export function simLeaseKey(holderId: string, worktreeRoot: string): string {
  return `${holderId}@${worktreeRoot}`
}

function holderOf(facts: SimCallerFacts): SimHolder | null {
  const suffix = facts.holderName ? `/${facts.holderName}` : ''
  const named = facts.holderName ? { name: facts.holderName } : {}
  const pane = facts.terminalHandle ? { terminalHandle: facts.terminalHandle } : {}
  const { agent, paneAgentSession: session, parent } = facts
  if (agent) {
    const sameSession =
      session && session.agent === agent.agent ? { sessionId: session.sessionId } : {}
    return {
      kind: 'agent',
      id: `agent:${agent.agent}:${agent.pid}:${agent.startedAt}${suffix}`,
      ...named,
      ...agent,
      ...sameSession,
      ...pane
    }
  }
  if (session) {
    return {
      kind: 'agentSession',
      id: `session:${session.sessionId}${suffix}`,
      ...named,
      ...session,
      ...pane
    }
  }
  if (facts.terminalHandle) {
    return {
      kind: 'terminal',
      id: `terminal:${facts.terminalHandle}${suffix}`,
      ...named,
      terminalHandle: facts.terminalHandle
    }
  }
  if (parent) {
    return {
      kind: 'process',
      id: `process:${parent.pid}:${parent.startedAt}${suffix}`,
      ...named,
      ...parent
    }
  }
  if (facts.holderName) {
    return { kind: 'human', id: `human:${facts.holderName}`, name: facts.holderName }
  }
  return null
}

export function resolveSimLeaseKey(facts: SimCallerFacts): SimLeaseKeyResolution {
  const worktreeRoot =
    facts.worktreeFlagRoot ??
    facts.cwdGitToplevel ??
    facts.cwdWorkspaceRoot ??
    facts.envWorktreePath
  if (!worktreeRoot) {
    return { ok: false, refusal: 'no_worktree' }
  }
  const holder = holderOf(facts)
  if (!holder) {
    return { ok: false, refusal: 'no_holder' }
  }
  return { ok: true, key: simLeaseKey(holder.id, worktreeRoot), worktreeRoot, holder }
}
