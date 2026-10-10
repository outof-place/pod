import { createHash, randomUUID } from 'node:crypto'

/** A plan outlives a slow read of it, not a coffee break: the user re-scans after this. */
export const WORKSPACE_PLAN_TTL_MS = 15 * 60 * 1000
// Per kind, so a client that polls the status cannot evict the tidy plan the user is reading.
const MAX_PLANS_PER_KIND = 32

export type WorkspacePlanKind = 'tidy' | 'profile' | 'adopt' | 'adopt-undo' | 'status'

type Entry = {
  kind: WorkspacePlanKind
  createdAt: number
  fingerprints: Map<string, string>
  /** What the whole plan is about (a repo id), for applies that name only the plan. */
  subject: string | null
}

export class WorkspacePlanError extends Error {}

/** Same input, same fingerprint: a stable JSON of what an apply depends on. */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/**
 * Plans the runtime handed out, by id: what each target looked like when the user saw it.
 * In memory only, so a runtime restart expires every plan.
 */
export function createWorkspacePlanStore(now: () => number = Date.now) {
  const plans = new Map<string, Entry>()

  const prune = (): void => {
    const cutoff = now() - WORKSPACE_PLAN_TTL_MS
    for (const [id, entry] of plans) {
      if (entry.createdAt < cutoff) {
        plans.delete(id)
      }
    }
  }

  const makeRoom = (kind: WorkspacePlanKind): void => {
    const ofKind = [...plans].filter(([, entry]) => entry.kind === kind)
    // Map order is insertion order: the first ones are the oldest.
    for (const [id] of ofKind.slice(0, Math.max(0, ofKind.length - MAX_PLANS_PER_KIND + 1))) {
      plans.delete(id)
    }
  }

  const issue = (
    kind: WorkspacePlanKind,
    fingerprints: Map<string, string>,
    subject: string | null = null
  ): { planId: string; expiresAt: number } => {
    prune()
    makeRoom(kind)
    const planId = randomUUID()
    const createdAt = now()
    plans.set(planId, { kind, createdAt, fingerprints, subject })
    return { planId, expiresAt: createdAt + WORKSPACE_PLAN_TTL_MS }
  }

  const entryOf = (planId: string, kind: WorkspacePlanKind): Entry => {
    prune()
    const entry = plans.get(planId)
    if (!entry || entry.kind !== kind) {
      throw new WorkspacePlanError('This plan has expired. Look again before changing anything.')
    }
    return entry
  }

  const subjectOf = (planId: string, kind: WorkspacePlanKind): string => {
    const subject = entryOf(planId, kind).subject
    if (subject === null) {
      throw new WorkspacePlanError('This plan does not cover that item. Look again first.')
    }
    return subject
  }

  /** The fingerprint the plan recorded for `target`; throws when the plan can't back an apply. */
  const expected = (planId: string, kind: WorkspacePlanKind, target: string): string => {
    const fingerprint = entryOf(planId, kind).fingerprints.get(target)
    if (fingerprint === undefined) {
      throw new WorkspacePlanError('This plan does not cover that item. Look again first.')
    }
    return fingerprint
  }

  /** Refuses when `current` differs from what the user was shown. */
  const verify = (planId: string, kind: WorkspacePlanKind, target: string, current: string) => {
    if (expected(planId, kind, target) !== current) {
      throw new WorkspacePlanError('This changed since you looked. Look again before changing it.')
    }
  }

  /** One apply per plan: a second click on the same plan must look again. */
  const consume = (planId: string): void => {
    plans.delete(planId)
  }

  return { issue, subjectOf, expected, verify, consume }
}

export type WorkspacePlanStore = ReturnType<typeof createWorkspacePlanStore>
