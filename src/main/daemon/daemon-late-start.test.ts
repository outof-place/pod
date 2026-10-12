import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetLateDaemonStartForTests,
  scheduleLateDaemonStart,
  scheduleLateDaemonStartOnDarwin
} from './daemon-late-start'

beforeEach(() => {
  vi.useFakeTimers()
  resetLateDaemonStartForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduleLateDaemonStart', () => {
  it('tries again after each failure, and stops once the daemon is up', async () => {
    let daemon = false
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Daemon startup timed out'))
      .mockImplementationOnce(async () => {
        daemon = true
      })
    scheduleLateDaemonStart({
      start,
      hasDaemon: () => daemon,
      isQuitting: () => false,
      delaysMs: [5_000, 30_000, 120_000]
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(start).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(start).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(start).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('started late'))
  })

  it('gives up after its last delay', async () => {
    const start = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('exited'))
    scheduleLateDaemonStart({
      start,
      hasDaemon: () => false,
      isQuitting: () => false,
      delaysMs: [1, 1]
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(start).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('gave up'))
  })

  it('does nothing during a quit, or when a daemon was installed meanwhile', async () => {
    const start = vi.fn<() => Promise<void>>()
    scheduleLateDaemonStart({ start, hasDaemon: () => true, isQuitting: () => false })
    await vi.advanceTimersByTimeAsync(200_000)
    resetLateDaemonStartForTests()
    scheduleLateDaemonStart({ start, hasDaemon: () => false, isQuitting: () => true })
    await vi.advanceTimersByTimeAsync(200_000)
    expect(start).not.toHaveBeenCalled()
  })

  it('schedules once per process', async () => {
    const start = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('no'))
    const late = { start, hasDaemon: () => false, isQuitting: () => false, delaysMs: [1] }
    scheduleLateDaemonStart(late)
    scheduleLateDaemonStart(late)
    await vi.advanceTimersByTimeAsync(10)
    expect(start).toHaveBeenCalledTimes(1)
  })
})

describe('scheduleLateDaemonStartOnDarwin', () => {
  it('starts the daemon in late mode with the startup options', async () => {
    const init = vi.fn(async () => {})
    const isQuitting = (): boolean => false
    scheduleLateDaemonStartOnDarwin(
      init,
      { macosLoginSessionWatch: true, isQuitting },
      () => false,
      'darwin'
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(init).toHaveBeenCalledWith({ macosLoginSessionWatch: true, isQuitting, late: true })
  })

  it('stays off elsewhere', async () => {
    const init = vi.fn(async () => {})
    scheduleLateDaemonStartOnDarwin(init, {}, () => false, 'linux')
    await vi.advanceTimersByTimeAsync(200_000)
    expect(init).not.toHaveBeenCalled()
  })
})
