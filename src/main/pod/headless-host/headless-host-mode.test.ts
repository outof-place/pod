import { describe, expect, it } from 'vitest'
import { isPodHeadlessHost, podHeadlessHostCuts } from './headless-host-mode'

const HOST_ARGV = ['electron', '.', '--serve', '--pod-headless-host']

describe('Pod headless host mode', () => {
  it('applies only to serve launches that ask for it', () => {
    expect(isPodHeadlessHost(HOST_ARGV, {})).toBe(true)
    expect(isPodHeadlessHost(['electron', '.', '--serve'], { POD_HEADLESS_HOST: '1' })).toBe(true)
    // Why: plain `serve` keeps its listener (on loopback in Pod, see pod-runtime-websocket.ts).
    expect(isPodHeadlessHost(['electron', '.', '--serve'], {})).toBe(false)
    expect(isPodHeadlessHost(['electron', '.', '--pod-headless-host'], {})).toBe(false)
    expect(podHeadlessHostCuts(['electron', '.'], { POD_HEADLESS_HOST: '1' })).toBeNull()
  })

  it('cuts the spare renderer by default, and merges processes only on request', () => {
    expect(podHeadlessHostCuts(HOST_ARGV, {})).toEqual({
      releaseSpareRenderer: true,
      inProcessGpu: false,
      inProcessNetwork: false
    })
    expect(
      podHeadlessHostCuts(HOST_ARGV, {
        POD_HEADLESS_SPARE_RENDERER: '1',
        POD_HEADLESS_IN_PROCESS_GPU: '1',
        POD_HEADLESS_IN_PROCESS_NETWORK: '1'
      })
    ).toEqual({
      releaseSpareRenderer: false,
      inProcessGpu: true,
      inProcessNetwork: true
    })
  })
})
