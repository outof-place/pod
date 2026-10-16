import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SIM_HOLDER_KINDS, SimHolder } from '../../../../shared/pod-sim/sim-holder'
import { simHolderLiveness } from './sim-holder-liveness'

const Facts = z
  .object({
    process: z.union([
      z.literal('unknown'),
      z.object({ found: z.literal(true), startedAt: z.number().int() }).strict(),
      z.object({ found: z.literal(false) }).strict()
    ]),
    session: z.enum(['notServedHere', 'storeWarming', 'present', 'ended']),
    terminal: z.enum(['notServedHere', 'storeWarming', 'open', 'closed'])
  })
  .strict()
const table = z
  .array(
    z
      .object({
        name: z.string(),
        holder: SimHolder,
        facts: Facts,
        liveness: z.enum(['live', 'unverifiable', 'exited'])
      })
      .strict()
  )
  .parse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'liveness.json'), 'utf8')))

describe('holder liveness (fixtures/liveness.json)', () => {
  for (const { name, holder, facts, liveness } of table) {
    it(name, () => {
      expect(simHolderLiveness(holder, facts)).toBe(liveness)
    })
  }

  it('covers every holder kind against every verdict it can reach', () => {
    const seen = new Set(table.map((row) => `${row.holder.kind}:${row.liveness}`))
    for (const kind of SIM_HOLDER_KINDS) {
      const verdicts = kind === 'human' ? ['live'] : ['live', 'unverifiable', 'exited']
      for (const verdict of verdicts) {
        expect(seen.has(`${kind}:${verdict}`), `${kind} ${verdict}`).toBe(true)
      }
    }
  })
})
