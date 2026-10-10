import { describe, expect, it } from 'vitest'
import { isPodHeadlessHost, podHeadlessHostCuts } from './headless-host-mode'

const HOST_ARGV = ['electron', '.', '--serve', '--pod-headless-host']

describe('Pod headless host mode', () => {
  it('applies only to serve launches that ask for it', () => {
    expect(isPodHeadlessHost(HOST_ARGV, {})).toBe(true)
    expect(isPodHeadlessHost(['electron', '.', '--serve'], { POD_HEADLESS_HOST: '1' })).toBe(true)
    // Why: remote and VM `serve` hosts pair clients over the WebSocket and keep today's behavior.
    expect(isPodHeadlessHost(['electron', '.', '--serve'], {})).toBe(false)
    expect(isPodHeadlessHost(['electron', '.', '--pod-headless-host'], {})).toBe(false)
    expect(podHeadlessHostCuts(['electron', '.'], { POD_HEADLESS_HOST: '1' })).toBeNull()
  })

  it('cuts the listener and the spare renderer by default, and merges processes only on request', () => {
    expect(podHeadlessHostCuts(HOST_ARGV, {})).toEqual({
      dropWebSocket: true,
      releaseSpareRenderer: true,
      inProcessGpu: false,
      inProcessNetwork: false
    })
    expect(
      podHeadlessHostCuts(HOST_ARGV, {
        POD_HEADLESS_HOST_WEBSOCKET: '1',
        POD_HEADLESS_SPARE_RENDERER: '1',
        POD_HEADLESS_IN_PROCESS_GPU: '1',
        POD_HEADLESS_IN_PROCESS_NETWORK: '1'
      })
    ).toEqual({
      dropWebSocket: false,
      releaseSpareRenderer: false,
      inProcessGpu: true,
      inProcessNetwork: true
    })
  })
})
