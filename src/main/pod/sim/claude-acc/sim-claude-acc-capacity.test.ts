import { describe, expect, it } from 'vitest'
import type { SimRun, SimRunResult } from '../adapters/sim-command-run'
import { createClaudeAccCapacity } from './sim-claude-acc-capacity'

const NOW = 1_792_200_000_000
const POD_UDID = '0A0A0A0A-0000-4000-8000-00000000000A'
const S56 = 'D714382D-D685-4FBE-AB4D-9B369EF9F348'
const AUTO = '2018C231-345C-4739-8109-695CB0FA166A'

/** The guard's snapshot as `claude-acc guard status --json` prints it (devguard_core.py). */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    at: NOW / 1000 - 3,
    mode: 'enforce',
    pressure: { stage: 0, level: 1 },
    simulator_cap: 2,
    simulators: [
      // Pod's own device, seen through its launchd_sim argv: not "outside".
      { udid: POD_UDID, name: POD_UDID, pool: false, in_use: true, protected: false },
      { udid: S56, name: 'Portivo-S56-iPhone16Pro', pool: true, in_use: false, protected: false },
      { udid: AUTO, name: 'Portivo-Auto-1', pool: true, in_use: true, protected: false }
    ],
    ...overrides
  }
}

function capacity(
  options: {
    cli?: SimRunResult
    stateText?: string | null
    binary?: string | null
    podDevices?: ReadonlySet<string> | null
  } = {}
) {
  const calls: string[][] = []
  const run: SimRun = async (program, args) => {
    calls.push([program, ...args])
    return options.cli ?? { ok: true, code: 0, stdout: JSON.stringify(snapshot()), stderr: '' }
  }
  const port = createClaudeAccCapacity({
    podCap: 2,
    podDevices: async () =>
      options.podDevices === undefined ? new Set([POD_UDID]) : options.podDevices,
    binary: options.binary === undefined ? '/x/claude-acc' : options.binary,
    stateFile: '/x/devguard-state.json',
    run,
    readText: async () => (options.stateText === undefined ? null : options.stateText),
    now: () => NOW,
    bootedOutsidePod: async () => 1
  })
  return { port, calls }
}

describe('claude-acc’s capacity reading', () => {
  it('reads cap, brake, booted devices outside Pod and agents in use from the guard', async () => {
    const { port, calls } = capacity()
    expect(await port.read()).toEqual({
      source: 'claudeAcc',
      cap: 2,
      outsideBooted: 2,
      agentsInUse: 1,
      brake: 'calm',
      measuredAt: NOW - 3000
    })
    expect(calls).toEqual([['/x/claude-acc', 'guard', 'status', '--json']])
  })

  it('names each brake stage, and a stage it does not know is unknown, never calm', async () => {
    const stages: [unknown, string][] = [
      [1, 'tight'],
      [2, 'brake'],
      [3, 'emergency'],
      [7, 'unknown'],
      [null, 'unknown']
    ]
    for (const [stage, brake] of stages) {
      const cli = {
        ok: true as const,
        code: 0,
        stdout: JSON.stringify(snapshot({ pressure: { stage } })),
        stderr: ''
      }
      expect((await capacity({ cli }).port.read()).brake, `stage ${String(stage)}`).toBe(brake)
    }
  })

  it('passes claude-acc’s cap 0 ("no cap there") through for the core to replace', async () => {
    const cli = {
      ok: true as const,
      code: 0,
      stdout: JSON.stringify(snapshot({ simulator_cap: 0 })),
      stderr: ''
    }
    expect((await capacity({ cli }).port.read()).cap).toBe(0)
  })

  it('takes a fresh snapshot from the guard’s state file without starting claude-acc', async () => {
    const stateText = JSON.stringify({ snapshot: snapshot(), events: [] })
    const { port, calls } = capacity({ stateText })
    expect(await port.read()).toMatchObject({ cap: 2, brake: 'calm', measuredAt: NOW - 3000 })
    expect(calls).toEqual([])
  })

  it('asks claude-acc itself when the state file’s snapshot is old', async () => {
    const stateText = JSON.stringify({ snapshot: snapshot({ at: NOW / 1000 - 45 }) })
    const { port, calls } = capacity({ stateText })
    expect((await port.read()).measuredAt).toBe(NOW - 3000)
    expect(calls).toHaveLength(1)
  })

  it('takes a snapshot stamped in the future only within the core’s own tolerance', async () => {
    // Ten seconds ahead is a clock step (SIM_CAPACITY_FUTURE_MS), not a fresh reading.
    const stateText = JSON.stringify({ snapshot: snapshot({ at: NOW / 1000 + 10 }) })
    const { port, calls } = capacity({ stateText })
    expect((await port.read()).measuredAt).toBe(NOW - 3000)
    expect(calls).toHaveLength(1)
  })

  it('does not know the outside count while Pod’s own set cannot be read', async () => {
    const { port } = capacity({ podDevices: null })
    expect(await port.read()).toMatchObject({ outsideBooted: 'unknown', cap: 2 })
  })

  it('knows nothing when claude-acc fails, times out or prints garbage', async () => {
    const failures: SimRunResult[] = [
      { ok: false, reason: 'timeout', message: 'claude-acc ran past 4000 ms' },
      { ok: true, code: 1, stdout: '', stderr: 'Traceback' },
      { ok: true, code: 0, stdout: 'not json', stderr: '' }
    ]
    for (const cli of failures) {
      expect(await capacity({ cli }).port.read()).toEqual({
        source: 'claudeAcc',
        cap: 'unknown',
        outsideBooted: 'unknown',
        agentsInUse: 'unknown',
        brake: 'unknown',
        measuredAt: null
      })
    }
  })

  it('does not know the outside count when the guard did not list simulators', async () => {
    const cli = {
      ok: true as const,
      code: 0,
      stdout: JSON.stringify(snapshot({ simulators: undefined })),
      stderr: ''
    }
    expect(await capacity({ cli }).port.read()).toMatchObject({
      outsideBooted: 'unknown',
      agentsInUse: 'unknown'
    })
  })

  it('without claude-acc on this Mac, reads Pod’s own cap and calm, counting what is booted outside', async () => {
    const { port, calls } = capacity({ binary: null })
    expect(await port.read()).toEqual({
      source: 'pod',
      cap: 2,
      outsideBooted: 1,
      agentsInUse: 'unknown',
      brake: 'calm',
      measuredAt: NOW
    })
    expect(calls).toEqual([])
  })
})
