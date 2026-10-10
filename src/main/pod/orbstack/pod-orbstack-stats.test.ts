import { describe, expect, it, vi } from 'vitest'
import {
  createPodOrbstackDiskSizes,
  createPodOrbstackStats,
  parseCgroupRead
} from './pod-orbstack-stats'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

const CGROUP = [
  '@@ /sys/fs/cgroup/cpu.stat',
  'usage_usec 6363918',
  'user_usec 4139616',
  '@@ /sys/fs/cgroup/memory.current',
  '530956288',
  '@@ /sys/fs/cgroup/memory.max',
  'max',
  '@@ /sys/fs/cgroup/memory.stat',
  'anon 19881984',
  'inactive_file 500000000',
  ''
].join('\n')

const ok = (stdout: string): OrbstackToolResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false
})

function setup(options: { listed?: { name: string; state: string }[]; timeout?: string } = {}) {
  let clock = 1_000
  const listed = options.listed ?? [
    { name: 'pod-a-12345678-sbx', state: 'running' },
    { name: 'pod-b-12345678', state: 'stopped' },
    { name: 'user-machine', state: 'running' },
    { name: 'pod-sbx-12345678-tmpl', state: 'running' }
  ]
  const run = vi.fn<OrbstackToolRunner>(async (_tool, args) => {
    if (args[0] === 'list') {
      return ok(JSON.stringify(listed))
    }
    if (args[0] === 'info') {
      return ok(JSON.stringify({ disk_size: 694636544 }))
    }
    if (args[2] === options.timeout) {
      return { code: null, stdout: '', stderr: '', timedOut: true }
    }
    return ok(CGROUP)
  })
  const stats = createPodOrbstackStats({
    run,
    podMachines: () => ['pod-a-12345678-sbx', 'pod-b-12345678', 'pod-c-12345678'],
    diskSizes: createPodOrbstackDiskSizes({ run, now: () => clock }),
    now: () => clock
  })
  return { run, stats, tick: (ms: number) => (clock += ms) }
}

const runs = (run: ReturnType<typeof setup>['run']) =>
  run.mock.calls.filter((call) => call[1][0] === 'run').map((call) => call[1][2])

describe('orbstack stats', () => {
  it('parses one machine cgroup, memory without inactive file cache, max as no limit', () => {
    expect(parseCgroupRead(CGROUP)).toEqual({
      cpuUsageUsec: 6363918,
      memoryBytes: 30956288,
      memoryLimitBytes: null
    })
    expect(parseCgroupRead(CGROUP.replace('\nmax\n', '\n4294967296\n'))?.memoryLimitBytes).toBe(
      4294967296
    )
    expect(parseCgroupRead('')).toBeNull()
  })

  it('reads only running Pod machines, never templates, stopped or foreign ones', async () => {
    const { run, stats } = setup()
    const result = await stats.read()
    expect(result).toMatchObject({
      tick: 1,
      sampledAt: 1_000,
      machines: [{ name: 'pod-a-12345678-sbx', cpuUsageUsec: 6363918, diskBytes: 694636544 }],
      errors: []
    })
    expect(runs(run)).toEqual(['pod-a-12345678-sbx'])
  })

  it('shares one tick between callers and samples again after 2 s', async () => {
    const { run, stats, tick } = setup()
    const [first, second] = await Promise.all([stats.read(), stats.read(['pod-a-12345678-sbx'])])
    expect(first.tick).toBe(1)
    expect(second.tick).toBe(1)
    expect(runs(run)).toHaveLength(1)
    tick(1_999)
    expect((await stats.read()).tick).toBe(1)
    tick(1)
    expect((await stats.read()).tick).toBe(2)
    expect(runs(run)).toHaveLength(2)
    // The disk size is cached for 30 s.
    expect(run.mock.calls.filter((call) => call[1][0] === 'info')).toHaveLength(1)
  })

  it("reports a timed-out machine and a name that is not Pod's as errors", async () => {
    const { stats } = setup({
      listed: [
        { name: 'pod-a-12345678-sbx', state: 'running' },
        { name: 'pod-c-12345678', state: 'running' }
      ],
      timeout: 'pod-c-12345678'
    })
    const result = await stats.read(['pod-a-12345678-sbx', 'pod-c-12345678', 'user-machine'])
    expect(result.machines.map((machine) => machine.name)).toEqual(['pod-a-12345678-sbx'])
    expect(result.errors).toEqual([
      'pod-c-12345678: timed out',
      'user-machine is not a Pod machine'
    ])
  })
})
