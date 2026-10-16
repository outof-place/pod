import { describe, expect, it } from 'vitest'
import { POD_SIM_RUNTIME_CAPABILITY } from '../../shared/pod-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import { SIM_RPC_METHODS } from '../../shared/rpc-contract/sim-params'
import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { COMMAND_SPECS } from './index'
import { SIM_COMMAND_METHODS, SIM_COMMAND_SPECS } from './sim'

describe('podx sim specs', () => {
  it('are in the command table, each verb bound to a sim method', () => {
    for (const spec of SIM_COMMAND_SPECS) {
      expect(COMMAND_SPECS).toContain(spec)
      const [, verb] = spec.path
      expect(SIM_RPC_METHODS, spec.path.join(' ')).toContain(SIM_COMMAND_METHODS[verb ?? ''])
    }
    expect(Object.keys(SIM_COMMAND_METHODS).sort()).toEqual(
      SIM_COMMAND_SPECS.map((spec) => spec.path[1]).sort()
    )
  })

  it('stay hidden while no handler routes them', () => {
    for (const spec of SIM_COMMAND_SPECS) {
      expect(spec.hidden === true || HANDLER_COMMAND_KEYS.has(spec.path.join(' '))).toBe(true)
    }
  })

  it('take the caller flags on every verb', () => {
    for (const spec of SIM_COMMAND_SPECS) {
      expect(spec.allowedFlags).toEqual(expect.arrayContaining(['holder', 'worktree', 'json']))
    }
  })

  it('are not advertised: no runtime lists pod.sim.v1 before its handlers land', () => {
    expect(POD_SIM_RUNTIME_CAPABILITY).toBe('pod.sim.v1')
    expect(RUNTIME_CAPABILITIES).not.toContain(POD_SIM_RUNTIME_CAPABILITY)
  })
})
