import { afterEach, describe, expect, it, vi } from 'vitest'
import { setActiveSink } from '../observability/tracer'
import { reportDaemonHost } from './daemon-host-darwin-report'

const pushed: unknown[] = []

afterEach(() => {
  setActiveSink(null)
  pushed.length = 0
  vi.restoreAllMocks()
})

describe('reportDaemonHost', () => {
  it('writes a fallback to the trace log as a failed span, not only to the console', () => {
    setActiveSink({ push: (record) => pushed.push(record), flush: () => {}, close: () => {} })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportDaemonHost('bundle', 'volume cannot clone; forking from the app bundle')
    expect(warn).toHaveBeenCalledWith(
      '[daemon] daemon-host: volume cannot clone; forking from the app bundle'
    )
    expect(pushed).toEqual([
      expect.objectContaining({
        name: 'daemon-host.darwin',
        attributes: expect.objectContaining({ outcome: 'bundle' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    ])
  })

  it('ends a clone as a successful span', () => {
    setActiveSink({ push: (record) => pushed.push(record), flush: () => {}, close: () => {} })
    vi.spyOn(console, 'info').mockImplementation(() => {})
    reportDaemonHost('cloned', 'cloned Pod Runtime.app 1.0.0')
    expect(pushed).toEqual([expect.objectContaining({ exit: { _tag: 'Success' } })])
  })
})
