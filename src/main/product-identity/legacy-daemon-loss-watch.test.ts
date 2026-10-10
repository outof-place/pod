import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDaemonShutdownReason, watchMovedDaemons } from './legacy-daemon-loss-watch'

let root = ''
let pod = ''
let logPath = ''

function moved(pid: number, protocol = 41): Record<string, unknown> {
  return {
    protocol,
    pid,
    files: [`daemon-v${protocol}.sock`],
    from: '/orca/daemon',
    to: '/pod/daemon'
  }
}

function writeMarker(handover: Record<string, unknown>): void {
  writeFileSync(
    join(pod, 'product-profile-migration.json'),
    JSON.stringify({ from: join(root, 'orca'), daemonHandover: handover })
  )
}

function handover(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pod, 'product-profile-migration.json'), 'utf8'))
    .daemonHandover
}

function logLine(pid: number, event: string, reason?: string): string {
  return `${JSON.stringify({ src: 'daemon', ts: '2026-10-10T03:10:24.486Z', pid, event, reason })}\n`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dlw-'))
  pod = join(root, 'pod')
  mkdirSync(pod)
  mkdirSync(join(root, 'orca/logs'), { recursive: true })
  logPath = join(root, 'orca/logs/daemon.log')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('readDaemonShutdownReason', () => {
  it("reads the pid's last shutdown reason, from the rotated copy when needed", () => {
    writeFileSync(`${logPath}.1`, logLine(7, 'shutdown', 'idle') + logLine(8, 'shutdown', 'rpc'))
    writeFileSync(logPath, `{"torn\n${logLine(7, 'shutdown', 'SIGTERM')}${logLine(7, 'closed')}`)
    expect(readDaemonShutdownReason(logPath, 7)).toBe('SIGTERM')
    expect(readDaemonShutdownReason(logPath, 8)).toBe('rpc')
    expect(readDaemonShutdownReason(logPath, 9)).toBeNull()
    expect(readDaemonShutdownReason(join(root, 'missing.log'), 7)).toBeNull()
  })
})

describe('watchMovedDaemons', () => {
  it('records a daemon that died holding terminals as lost, once, and tells the user', () => {
    writeMarker({ decision: 'moved', moved: [moved(101), moved(102, 39)] })
    const alive = new Set([101, 102])
    const onLost = vi.fn()
    const stop = watchMovedDaemons({ userData: pod, onLost, isAlive: (pid) => alive.has(pid) })

    writeFileSync(logPath, logLine(101, 'shutdown', 'SIGTERM'))
    alive.delete(101)
    vi.advanceTimersByTime(10_000)
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ pid: 101, reason: 'SIGTERM' }))
    expect(handover()).toMatchObject({
      decision: 'moved',
      lost: [{ protocol: 41, pid: 101, reason: 'SIGTERM' }]
    })

    // SIGKILL leaves no shutdown line.
    alive.delete(102)
    vi.advanceTimersByTime(10_000)
    expect(onLost).toHaveBeenCalledTimes(2)
    expect(handover().lost).toMatchObject([{ pid: 101 }, { protocol: 39, pid: 102, reason: null }])
    vi.advanceTimersByTime(60_000)
    expect(onLost).toHaveBeenCalledTimes(2)
    stop()

    // The next launch never reports the same daemons again.
    watchMovedDaemons({ userData: pod, onLost, isAlive: () => false })
    expect(onLost).toHaveBeenCalledTimes(2)
  })

  it('records a daemon that ran out of terminals as ended, without a notice', () => {
    writeMarker({ decision: 'moved', moved: [moved(201)] })
    let alive = true
    const onLost = vi.fn()
    watchMovedDaemons({ userData: pod, onLost, isAlive: () => alive })
    writeFileSync(logPath, logLine(201, 'shutdown', 'idle'))
    alive = false
    vi.advanceTimersByTime(10_000)
    expect(onLost).not.toHaveBeenCalled()
    expect(handover()).toMatchObject({ ended: [{ pid: 201, reason: 'idle' }] })
    expect(handover().lost).toBeUndefined()
  })

  it('settles a daemon that died while the product was not running at launch', () => {
    writeMarker({ decision: 'moved', moved: [moved(301)] })
    writeFileSync(logPath, logLine(301, 'shutdown', 'SIGINT'))
    const onLost = vi.fn()
    watchMovedDaemons({ userData: pod, onLost, isAlive: () => false })
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ pid: 301, reason: 'SIGINT' }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing without moved daemons', () => {
    writeMarker({ decision: 'kept' })
    const onLost = vi.fn()
    watchMovedDaemons({ userData: pod, onLost, isAlive: () => false })
    expect(onLost).not.toHaveBeenCalled()
    expect(handover()).toEqual({ decision: 'kept' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
