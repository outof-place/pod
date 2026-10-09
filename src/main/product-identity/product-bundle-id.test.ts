import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/pod-app-data', setPath: vi.fn(), setName: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: vi.fn()
}))

import { getAppBundleId, setAppBundleId } from '../../shared/app-identity'
import {
  ensureMacPressAndHoldDefault,
  isOrcaPreferencesDomain
} from '../macos-press-and-hold-default'
import { applyProductIdentityPreReady } from './product-first-run'
import { parseProductIdentity } from './product-identity'

const podIdentity = parseProductIdentity(
  JSON.parse(readFileSync(join(__dirname, '../../../product/identity.json'), 'utf8'))
)

afterEach(() => setAppBundleId(null))

describe("the product's runtime bundle id", () => {
  it('is the product appId once the pre-ready identity applies', () => {
    expect(applyProductIdentityPreReady(podIdentity, true)).toBe(true)
    expect(getAppBundleId()).toBe('codes.pod.app')
  })

  it("points press-and-hold at Pod's defaults domain, never Orca's", () => {
    applyProductIdentityPreReady(podIdentity, true)
    expect(isOrcaPreferencesDomain('codes.pod.app')).toBe(true)
    expect(isOrcaPreferencesDomain('com.stablyai.orca')).toBe(false)

    const writes: string[] = []
    const decision = ensureMacPressAndHoldDefault({
      platform: 'darwin',
      resolveBundleIdentifier: () => 'codes.pod.app',
      readRecord: () => null,
      writeRecord: () => {},
      readDomainPreference: () => 'unset',
      writeDomainPreference: (domain) => {
        writes.push(domain)
        return true
      },
      now: () => '2026-10-10T00:00:00.000Z'
    })
    expect(decision).toBe('applied')
    expect(writes).toEqual(['codes.pod.app'])
  })
})
