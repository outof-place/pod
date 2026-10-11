import { describe, expect, it } from 'vitest'
import type { RpcRequest } from '../../runtime/rpc/core'
import { classifyRuntimeLongPoll } from '../../runtime/runtime-rpc/runtime-rpc-long-poll'
import { POD_ORBSTACK_LONG_METHODS } from './pod-orbstack-long-calls'
import { POD_ORBSTACK_METHODS } from './pod-orbstack-rpc-methods'

function classify(method: string) {
  const request: RpcRequest = { id: '1', authToken: 't', method, params: {} }
  return classifyRuntimeLongPoll(request)
}

describe('OrbStack changes as long-polls', () => {
  it('keeps machine changes and the restart alive past the idle timer, and no reads', () => {
    expect([...POD_ORBSTACK_LONG_METHODS].toSorted()).toEqual([
      'orbstack.create',
      'orbstack.delete',
      'orbstack.restart',
      'orbstack.setTemplates',
      'orbstack.start',
      'orbstack.stop'
    ])
    for (const method of POD_ORBSTACK_LONG_METHODS) {
      expect(classify(method), method).toBe('wait')
    }
    for (const method of ['orbstack.status', 'orbstack.stats', 'orbstack.setAgentSandbox']) {
      expect(classify(method), method).toBeNull()
    }
  })

  it('names only methods Pod registers', () => {
    const names = new Set<string>(POD_ORBSTACK_METHODS.map((entry) => entry.name))
    expect([...POD_ORBSTACK_LONG_METHODS].filter((method) => !names.has(method))).toEqual([])
  })
})
