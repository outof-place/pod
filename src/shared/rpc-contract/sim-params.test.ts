import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SIM_RPC_METHODS,
  SIM_RPC_PARAMS_BY_METHOD,
  SimLeaseParams,
  type SimRpcMethod
} from './sim-params'

const fixture = z
  .object({
    valid: z.array(z.object({ method: z.string(), params: z.unknown() }).strict()),
    invalid: z.array(
      z
        .object({ name: z.string(), method: z.string(), params: z.unknown(), path: z.string() })
        .strict()
    )
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(join(__dirname, '..', 'pod-sim', 'fixtures', 'rpc-params.json'), 'utf8')
    )
  )

function schemaFor(method: string): z.ZodType {
  const known = z.enum(SIM_RPC_METHODS).parse(method)
  const schema = SIM_RPC_PARAMS_BY_METHOD[known]
  if (!schema) {
    throw new Error(`${method} takes no params`)
  }
  return schema
}

describe('sim.* params', () => {
  it('accepts every valid fixture as sent, with nothing dropped', () => {
    for (const { method, params } of fixture.valid) {
      const parsed = schemaFor(method).safeParse(params)
      expect(parsed.success, `${method} ${JSON.stringify(params)}`).toBe(true)
      expect(parsed.data, method).toEqual(params)
    }
  })

  for (const { name, method, params, path } of fixture.invalid) {
    it(`refuses ${method}: ${name}, at ${path || 'the top level'}`, () => {
      const parsed = schemaFor(method).safeParse(params)
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(path)
    })
  }

  it("drops a newer CLI's caller hint instead of refusing the call", () => {
    const caller = { cwd: '/Users/dev/portivo-wt/maps', pid: 41290, agentHint: { model: 'opus' } }
    expect(SimLeaseParams.parse({ caller })).toEqual({
      caller: { cwd: '/Users/dev/portivo-wt/maps', pid: 41290 }
    })
  })

  it('has a valid fixture for every method that takes params', () => {
    const covered = new Set(fixture.valid.map(({ method }) => method))
    const missing = SIM_RPC_METHODS.filter(
      (method: SimRpcMethod) => SIM_RPC_PARAMS_BY_METHOD[method] !== null && !covered.has(method)
    )
    expect(missing).toEqual([])
  })

  it('names every method in the sim namespace', () => {
    expect(SIM_RPC_METHODS.filter((method) => !method.startsWith('sim.'))).toEqual([])
  })

  it('streams only sim.subscribe, with no params, as accounts.subscribe does', () => {
    expect(
      SIM_RPC_METHODS.filter((method: SimRpcMethod) => SIM_RPC_PARAMS_BY_METHOD[method] === null)
    ).toEqual(['sim.subscribe'])
  })
})
