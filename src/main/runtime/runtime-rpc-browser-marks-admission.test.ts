import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest } from './rpc/core'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'

const request = (method: string, params?: unknown): RpcRequest => ({
  id: method,
  authToken: 'test-token',
  method,
  params
})

describe('runtime RPC admission of agents waiting for marks', () => {
  it('meters marks --wait apart from terminal and orchestration waits', () => {
    expect(classifyRuntimeLongPoll(request('browser.marks', { wait: true }))).toBe('browser-marks')
    expect(classifyRuntimeLongPoll(request('browser.marks', { peek: true }))).toBeNull()
  })

  it('a fleet of agents waiting for marks leaves terminal.wait and check --wait their slots', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-marks-admission-'))
    try {
      const server = new OrcaRuntimeRpcServer({ runtime: new OrcaRuntimeService(), userDataPath })
      const admit = (kind: ReturnType<typeof classifyRuntimeLongPoll>): string | null =>
        server['admitLongPoll'](kind)
      const refused: string[] = []
      for (let i = 0; i < 16; i++) {
        const rejection = admit('browser-marks')
        if (rejection) {
          refused.push(rejection)
        }
      }
      // Four of the 16 slots at most; the rest answer busy and the agent retries later.
      expect(16 - refused.length).toBe(4)
      expect(refused[0]).toBe('browser.marks capacity reached; retry with backoff')
      for (let i = 0; i < 4; i++) {
        expect(admit('wait')).toBeNull()
      }
      server['releaseLongPoll']('browser-marks')
      expect(admit('browser-marks')).toBeNull()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
