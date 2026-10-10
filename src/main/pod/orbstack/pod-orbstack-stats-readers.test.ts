import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStatsReaders, type StatsReaderProcess } from './pod-orbstack-stats-readers'
import { createPodOrbstackDiskSizes, createPodOrbstackStats } from './pod-orbstack-stats'
import type { OrbstackToolRunner } from './pod-orbstack-tools'

const CGROUP_TEXT = [
  '@@ /sys/fs/cgroup/cpu.stat',
  'usage_usec 100',
  '@@ /sys/fs/cgroup/memory.current',
  '2048',
  '@@ /sys/fs/cgroup/memory.max',
  'max',
  '@@ /sys/fs/cgroup/memory.stat',
  'inactive_file 1024',
  ''
].join('\n')

/** A stand-in for `orb -m <machine> sh -c <loop>`: answers each stdin line with one marked read. */
class FakeReader extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  killed = false
  lines = 0

  constructor(answer: boolean) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const _ of chunk.toString().split('\n').slice(1)) {
        this.lines += 1
        if (answer) {
          this.stdout.write(`${CGROUP_TEXT}@@END\n`)
        }
      }
    })
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

function readersWith(answer = true) {
  const spawned: { machine: string; args: readonly string[]; child: FakeReader }[] = []
  const readers = createStatsReaders({
    spawn: (machine, args): StatsReaderProcess => {
      const child = new FakeReader(answer)
      spawned.push({ machine, args, child })
      return child
    },
    files: ['/sys/fs/cgroup/cpu.stat'],
    timeoutMs: 50,
    idleMs: 1_000
  })
  return { readers, spawned }
}

afterEach(() => vi.useRealTimers())

describe('stats readers', () => {
  it('keeps one process per machine and answers each read with one block', async () => {
    const { readers, spawned } = readersWith()
    expect(await readers.read('pod-a')).toBe(CGROUP_TEXT)
    expect(await readers.read('pod-a')).toBe(CGROUP_TEXT)
    expect(spawned.map((entry) => entry.machine)).toEqual(['pod-a'])
    expect(spawned[0]?.args.slice(0, 2)).toEqual(['sh', '-c'])
    expect(spawned[0]?.child.lines).toBe(2)
    readers.closeAll()
  })

  it('drops a reader that misses its deadline and a reader whose machine stopped', async () => {
    const { readers, spawned } = readersWith(false)
    expect(await readers.read('pod-a')).toBeNull()
    expect(readers.has('pod-a')).toBe(false)
    const live = readersWith()
    await live.readers.read('pod-b')
    live.spawned[0]?.child.emit('exit', 0, null)
    expect(live.readers.has('pod-b')).toBe(false)
    expect(spawned).toHaveLength(1)
  })

  it('closes readers of machines no longer sampled, and idle ones', async () => {
    vi.useFakeTimers()
    const { readers, spawned } = readersWith()
    const first = readers.read('pod-a')
    const second = readers.read('pod-b')
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, second])
    readers.retain(new Set(['pod-b']))
    expect(readers.has('pod-a')).toBe(false)
    expect(readers.has('pod-b')).toBe(true)
    expect(spawned[0]?.child.stdin.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(readers.has('pod-b')).toBe(false)
  })
})

describe('stats with readers', () => {
  it('reads through the readers and lists machines only until each has one', async () => {
    let clock = 1_000
    const run = vi.fn<OrbstackToolRunner>(async (_tool, args) => ({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify([{ name: 'pod-a-12345678', state: 'running' }])
          : JSON.stringify({ disk_size: 1 }),
      stderr: '',
      timedOut: false
    }))
    const { readers } = readersWith()
    const stats = createPodOrbstackStats({
      run,
      podMachines: () => ['pod-a-12345678'],
      diskSizes: createPodOrbstackDiskSizes({ run, now: () => clock }),
      readers,
      now: () => clock
    })
    const lists = () => run.mock.calls.filter((call) => call[1][0] === 'list').length
    const first = await stats.read()
    expect(first.machines.map((machine) => machine.memoryBytes)).toEqual([1024])
    clock += 2_000
    await stats.read()
    expect(lists()).toBe(1)
    expect(run.mock.calls.some((call) => call[1][0] === 'run')).toBe(false)
    stats.invalidate()
    clock += 2_000
    await stats.read()
    expect(lists()).toBe(2)
    readers.closeAll()
  })
})
