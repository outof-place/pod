import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn() } }
}))

import { applyPodHeadlessHostChromiumSwitches } from './headless-host-chromium-switches'
import type { PodHeadlessHostCuts } from './headless-host-mode'

function commandLine(initial: Record<string, string> = {}) {
  const switches = new Map(Object.entries(initial))
  return {
    switches,
    appendSwitch: (name: string, value?: string) => void switches.set(name, value ?? ''),
    getSwitchValue: (name: string) => switches.get(name) ?? ''
  }
}

const DEFAULT_CUTS: PodHeadlessHostCuts = {
  dropWebSocket: true,
  releaseSpareRenderer: true,
  inProcessGpu: false,
  inProcessNetwork: false
}

describe('Pod headless host Chromium switches', () => {
  it('adds nothing outside the headless host or without the opt-ins', () => {
    const outside = commandLine()
    applyPodHeadlessHostChromiumSwitches(null, outside)
    const defaults = commandLine()
    applyPodHeadlessHostChromiumSwitches(DEFAULT_CUTS, defaults)
    expect([...outside.switches.keys(), ...defaults.switches.keys()]).toEqual([])
  })

  it('merges the in-process network feature into the features already set', () => {
    const line = commandLine({ 'enable-features': 'EarlyEstablishGpuChannel' })
    applyPodHeadlessHostChromiumSwitches(
      { ...DEFAULT_CUTS, inProcessGpu: true, inProcessNetwork: true },
      line
    )
    expect(line.switches.get('in-process-gpu')).toBe('')
    expect(line.switches.get('enable-features')).toBe(
      'EarlyEstablishGpuChannel,NetworkServiceInProcess2'
    )
  })
})
