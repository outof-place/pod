import { describe, expect, it } from 'vitest'
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type { SimProcessFacts, SimProcessRow } from './sim-process-facts'
import { createSimLiveness, simSessionFromStatusRows } from './sim-liveness'

const POD_A = '0A0A0A0A-0000-4000-8000-00000000000A'
const POD_B = '0B0B0B0B-0000-4000-8000-00000000000B'
const FILIPS = 'D714382D-D685-4FBE-AB4D-9B369EF9F348'
const SELF_PID = 70110
const SET = '/Users/f/.pod/sim/CoreSimulator/Devices'

const AGENT: SimHolder = {
  kind: 'agent',
  id: 'agent:claude:41233:1760600000',
  agent: 'claude',
  pid: 41233,
  startedAt: 1_760_600_000,
  sessionId: 'sess-1',
  terminalHandle: 'term_1'
}
const SESSION: SimHolder = {
  kind: 'agentSession',
  id: 'session:sess-2',
  agent: 'claude',
  sessionId: 'sess-2'
}
const PANE: SimHolder = { kind: 'terminal', id: 'terminal:term_3', terminalHandle: 'term_3' }

function processes(
  starts: Record<number, number | 'unknown'>,
  table: SimProcessRow[] | null = []
): SimProcessFacts {
  return {
    startOf: async (pid) => {
      const start = starts[pid]
      if (start === 'unknown') {
        return 'unknown'
      }
      return start === undefined ? { found: false } : { found: true, startedAt: start }
    },
    table: async () => table
  }
}

function liveness(facts: SimProcessFacts, panes: Parameters<typeof createSimLiveness>[0]['panes']) {
  return createSimLiveness({
    deviceSet: SET,
    processes: facts,
    panes,
    podDevices: async () => new Set([POD_A, POD_B])
  })
}

describe('holder liveness facts', () => {
  it('reads an agent’s pid and start from any runtime', async () => {
    const port = liveness(processes({ 41233: 1_760_600_001 }), null)
    expect(await port.holderFacts(AGENT, false)).toEqual({
      process: { found: true, startedAt: 1_760_600_001 },
      session: 'notServedHere',
      terminal: 'notServedHere'
    })
    expect((await port.holderFacts(AGENT, false)).process).not.toBe('unknown')
    const gone = liveness(processes({}), null)
    expect((await gone.holderFacts(AGENT, false)).process).toEqual({ found: false })
  })

  it('asks Pod’s panes and sessions only where the holder was resolved', async () => {
    const panes = {
      session: (id: string) => (id === 'sess-2' ? ('ended' as const) : ('present' as const)),
      terminal: () => 'closed' as const
    }
    const here = liveness(processes({}), panes)
    expect(await here.holderFacts(SESSION, true)).toMatchObject({ session: 'ended' })
    expect(await here.holderFacts(PANE, true)).toMatchObject({ terminal: 'closed' })
    expect(await here.holderFacts(SESSION, false)).toMatchObject({ session: 'notServedHere' })
    expect(await here.holderFacts(PANE, false)).toMatchObject({ terminal: 'notServedHere' })
  })

  it('reads a runtime not yet wired to its panes as still warming, so nothing is released', async () => {
    const port = liveness(processes({}), null)
    expect(await port.holderFacts(SESSION, true)).toMatchObject({ session: 'storeWarming' })
    expect(await port.holderFacts(PANE, true)).toMatchObject({ terminal: 'storeWarming' })
  })

  it('reads a runtime as exited only when its pid is gone or runs another process', async () => {
    const port = liveness(
      processes({ 9001: 1_760_000_002, 9002: 1_760_000_010, 9003: 'unknown' }),
      null
    )
    expect(await port.runtime({ pid: 9001, startedAt: 1_760_000_000 })).toBe('live')
    expect(await port.runtime({ pid: 9002, startedAt: 1_760_000_000 })).toBe('exited')
    expect(await port.runtime({ pid: 9004, startedAt: 1_760_000_000 })).toBe('exited')
    // A failed lookup is loss of contact, not death.
    expect(await port.runtime({ pid: 9003, startedAt: 1_760_000_000 })).toBe('live')
  })
})

describe('outside use of Pod’s devices', () => {
  const table: SimProcessRow[] = [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: SELF_PID, ppid: 1, command: '/Applications/Pod.app/Contents/MacOS/Pod' },
    // Pod's device A booted: its launchd_sim and an app inside it carry its UDID.
    {
      pid: 500,
      ppid: 1,
      command: `launchd_sim ${SET}/${POD_A}/data/var/run/launchd_bootstrap.plist`
    },
    { pid: 501, ppid: 500, command: `${SET}/${POD_A}/data/App` },
    // The terminal daemon stays a child of the runtime that started it, and every agent's shell
    // under it: an agent's Maestro run there is use, as claude-acc counts it.
    {
      pid: 956,
      ppid: SELF_PID,
      command: '/Applications/Pod.app/Contents/MacOS/Pod --terminal-daemon'
    },
    { pid: 957, ppid: 956, command: '-zsh' },
    { pid: 958, ppid: 957, command: 'claude' },
    { pid: 959, ppid: 958, command: `java -jar maestro.jar --udid ${POD_B} test flow.yaml` },
    // Pod's own tool calls name its set: not outside use, nor what they start.
    { pid: 700, ppid: SELF_PID, command: `/x/simctl --set ${SET} spawn ${POD_A} launchctl list` },
    { pid: 710, ppid: SELF_PID, command: `/opt/homebrew/bin/simslim --set ${SET} on ${POD_A}` },
    { pid: 711, ppid: 710, command: `/usr/bin/xcrun simctl spawn ${POD_A} launchctl list` },
    {
      pid: 720,
      ppid: SELF_PID,
      command: `/Applications/Pod.app/Contents/Resources/bin/pod-sim --device ${POD_A}`
    },
    // Filip's own device in the default set: not Pod's.
    { pid: 800, ppid: 1, command: `xcodebuild -destination id=${FILIPS}` }
  ]

  it('counts an agent’s run under Pod’s terminal daemon, and none of Pod’s own tool calls', async () => {
    const port = liveness(processes({}, table), null)
    expect(await port.externalUse()).toEqual([POD_B])
  })

  it('counts a call naming another set, and the same daemon after its runtime exited', async () => {
    const other: SimProcessRow[] = [
      { pid: 956, ppid: 1, command: '/Applications/Pod.app/Contents/MacOS/Pod --terminal-daemon' },
      { pid: 960, ppid: 956, command: `xcrun simctl --set /tmp/other io ${POD_A} screenshot a.png` }
    ]
    const port = liveness(processes({}, other), null)
    expect(await port.externalUse()).toEqual([POD_A])
  })

  it('sees no use when the process table cannot be read', async () => {
    const port = liveness(processes({}, null), null)
    expect(await port.externalUse()).toEqual([])
  })
})

describe('agent sessions in Pod’s agent-status store', () => {
  const rows = [
    { paneKey: 'p1', providerSession: { key: 'session_id', id: 'live' } },
    {
      paneKey: 'p2',
      providerSession: { key: 'session_id', id: 'quit' },
      agentPresence: { agent: 'claude', ended: true }
    },
    {
      paneKey: 'p3',
      providerSession: { key: 'session_id', id: 'remnant' },
      providerSessionOnly: true
    },
    {
      paneKey: 'p4',
      providerSession: { key: 'session_id', id: 'restored' },
      restoredUnconfirmed: true
    }
  ]

  it('reads present, ended and still warming; no row at all is not an end', () => {
    expect(simSessionFromStatusRows(rows, 'live', true)).toBe('present')
    expect(simSessionFromStatusRows(rows, 'quit', true)).toBe('ended')
    expect(simSessionFromStatusRows(rows, 'remnant', true)).toBe('ended')
    expect(simSessionFromStatusRows(rows, 'restored', true)).toBe('storeWarming')
    expect(simSessionFromStatusRows(rows, 'never-seen', true)).toBe('unseen')
    expect(simSessionFromStatusRows(rows, 'live', false)).toBe('storeWarming')
  })
})
