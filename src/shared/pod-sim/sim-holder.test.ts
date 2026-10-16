import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveSimLeaseKey, SimCallerFactsSchema, SimHolder } from './sim-holder'

const Case = z.union([
  z
    .object({
      name: z.string(),
      facts: SimCallerFactsSchema,
      expect: z.object({ key: z.string(), worktreeRoot: z.string(), holder: SimHolder }).strict()
    })
    .strict(),
  z.object({ name: z.string(), facts: SimCallerFactsSchema, refused: z.string() }).strict()
])
const cases = z
  .array(Case)
  .parse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lease-keys.json'), 'utf8')))

describe('the lease key: (holder, git toplevel of the caller cwd)', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const resolved = resolveSimLeaseKey(testCase.facts)
      if ('refused' in testCase) {
        expect(resolved).toEqual({ ok: false, refusal: testCase.refused })
        return
      }
      expect(resolved).toEqual({ ok: true, ...testCase.expect })
    })
  }

  it('a subagent in another worktree gets a lease of its own, not its parent agent one', () => {
    const [own, subagent] = cases
    if (!own || !subagent || 'refused' in own || 'refused' in subagent) {
      throw new Error('fixture order changed')
    }
    expect(own.expect.holder.id).toBe(subagent.expect.holder.id)
    expect(own.expect.key).not.toBe(subagent.expect.key)
  })

  it('two parallel holders in one process differ only by --holder, and share without it', () => {
    const named = cases.filter(
      (testCase) =>
        !('refused' in testCase) && testCase.facts.holderName !== null && testCase.facts.agent
    )
    expect(named).toHaveLength(2)
    const keys = named.map((testCase) => resolveSimLeaseKey(testCase.facts))
    expect(keys[0]).not.toEqual(keys[1])
    const unnamed = named.map((testCase) =>
      resolveSimLeaseKey({ ...testCase.facts, holderName: null })
    )
    expect(unnamed[0]).toEqual(unnamed[1])
  })

  it('never holds by the podx process itself: its pid is no fact at all', () => {
    expect(Object.keys(SimCallerFactsSchema.shape)).not.toContain('pid')
  })
})

describe('SimHolder', () => {
  it('names no_holder only when not even --holder was given', () => {
    const human = cases.find(
      (testCase) => !('refused' in testCase) && testCase.expect.holder.kind === 'human'
    )
    if (!human || 'refused' in human) {
      throw new Error('no human holder fixture')
    }
    expect(resolveSimLeaseKey({ ...human.facts, holderName: null })).toEqual({
      ok: false,
      refusal: 'no_holder'
    })
  })

  it('refuses a session id, terminal handle or agent name that could break the key', () => {
    const agent = { kind: 'agent', id: 'agent:claude:1:2', pid: 1, startedAt: 2 } as const
    expect(SimHolder.safeParse({ ...agent, agent: 'claude code' }).success).toBe(false)
    expect(SimHolder.safeParse({ ...agent, agent: 'claude', sessionId: 'a@b' }).success).toBe(false)
    expect(SimHolder.safeParse({ ...agent, agent: 'claude', terminalHandle: 't 1' }).success).toBe(
      false
    )
  })

  it('refuses an agent holder with no process to check', () => {
    expect(
      SimHolder.safeParse({ kind: 'agent', id: 'agent:claude:1:2', agent: 'claude' }).success
    ).toBe(false)
  })

  it('refuses a holder id that could break the key', () => {
    expect(
      SimHolder.safeParse({ kind: 'terminal', id: 'terminal:a@b', terminalHandle: 'a@b' }).success
    ).toBe(false)
  })
})
