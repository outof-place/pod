import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * "Stopping…", paired across two builds.
 *
 * The host now publishes `stopping: true` on a working session's status summary. It is an
 * optional field an older reader must ignore (Rule 1): an old desktop folds a new host's summary
 * into a plain working row. A new reader of an old host, which never publishes the field, must
 * never read Stopping from it.
 *
 * The pre-change ref is pinned rather than derived: a newer baseline would carry the new reader.
 */
const PRE_CHANGE_REF = 'v1.4.214'
const SUITE_TIMEOUT_MS = 180_000
const STATUS_FOLD = 'src/shared/structured-agent-session-agent-status.ts'
const PROTOCOL_VERSION = 'src/shared/protocol-version.ts'
const MOBILE_ALLOWLIST = 'src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist.ts'
const STATUS_STREAM = 'agentSession.subscribeStatus'

const WORKTREE_ID = 'repo::/worktree'
const NOW = 1_000_000

type Summary = Record<string, unknown>
type Fold = (summary: Summary) => { state: string; mainAgent: Record<string, unknown> }

type Build = { fold: Fold }

/** A working session's summary as the new host publishes it, JSON round-tripped. */
const STOPPING_SUMMARY: Summary = JSON.parse(
  JSON.stringify({
    sessionId: 'session-1',
    workspaceId: WORKTREE_ID,
    agent: 'claude',
    status: 'working',
    latestPrompt: 'ship it',
    updatedAt: NOW,
    stopping: true
  })
)

async function loadBuild(ref: string | null): Promise<Build> {
  if (ref === null) {
    const fold = await import('../../../src/shared/structured-agent-session-agent-status')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this spec drives both builds' fold through one untyped surface.
    return { fold: fold.structuredAgentSessionAgentStatus as unknown as Fold }
  }
  const checkout = await materializeReleaseCheckout(ref)
  const fold = await importReleaseCheckoutModule(checkout, STATUS_FOLD)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; this is the old build's summary fold by path.
  return { fold: fold.structuredAgentSessionAgentStatus as unknown as Fold }
}

let oldBuild: Build
let newBuild: Build

beforeAll(async () => {
  ;[oldBuild, newBuild] = await Promise.all([loadBuild(PRE_CHANGE_REF), loadBuild(null)])
}, SUITE_TIMEOUT_MS)

describe('cross-version Stopping', () => {
  it('pairs two real builds that disagree on the field', () => {
    // Anti-vacuous-pass oracle: one module resolved twice would make every cell same-version.
    expect(oldBuild.fold).not.toBe(newBuild.fold)
    expect(newBuild.fold(STOPPING_SUMMARY).mainAgent).toMatchObject({ stopping: true })
    expect(oldBuild.fold(STOPPING_SUMMARY).mainAgent).not.toHaveProperty('stopping')
  })

  it('an OLD desktop folds a new host summary into the plain working row it always drew', () => {
    expect(oldBuild.fold(STOPPING_SUMMARY)).toEqual({
      state: 'working',
      mainAgent: { state: 'working' }
    })
  })

  it('a NEW reader of an old host never reads Stopping, which that host never publishes', () => {
    const { stopping: _stopping, ...oldSummary } = STOPPING_SUMMARY
    expect(newBuild.fold(oldSummary)).toEqual({ state: 'working', mainAgent: { state: 'working' } })
  })

  // The phone's chat reads Stopping from the status stream only on a host that lets phones call it.
  it('an OLD host advertising the status feed refuses it to a NEW phone, which reads that as no feed', async () => {
    const checkout = await materializeReleaseCheckout(PRE_CHANGE_REF)
    const [oldProtocol, oldAllowlist, newProtocol, newAllowlist] = await Promise.all([
      importReleaseCheckoutModule(checkout, PROTOCOL_VERSION),
      importReleaseCheckoutModule(checkout, MOBILE_ALLOWLIST),
      import('../../../src/shared/protocol-version'),
      import('../../../src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist')
    ])
    const capability = newProtocol.AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    expect(oldProtocol.RUNTIME_CAPABILITIES).toContain(capability)
    // Anti-vacuous oracle: the old Set answers membership for a method it does grant phones.
    expect(oldAllowlist.MOBILE_RPC_METHOD_ALLOWLIST).toContain('agentSession.subscribe')
    // The capability alone is no grant: this host's mobile gate answers `forbidden`, which the
    // phone's feed reads as absence (mobile-structured-session-status-feed.test.ts).
    expect(oldAllowlist.MOBILE_RPC_METHOD_ALLOWLIST).not.toContain(STATUS_STREAM)
    expect(newProtocol.RUNTIME_CAPABILITIES).toContain(capability)
    expect(newAllowlist.MOBILE_RPC_METHOD_ALLOWLIST.has(STATUS_STREAM)).toBe(true)
  })
})
