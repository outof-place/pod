// Fork-only (Pod): agent access to Linear is a sealed file only Pod writes. A hand-edited file, a
// settings-file key, or a keychain that can't seal all leave agents out.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../../shared/secret-store'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'

let userData = ''
let accessFile = ''

async function freshAccess() {
  vi.resetModules()
  const store = await import('./pod-linear-agent-access-store')
  const access = await import('./pod-linear-access')
  const { installPodLinear } = await import('./install-pod-linear')
  return { store, access, installPodLinear }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'pod-linear-agent-access-'))
  accessFile = join(userData, 'integrations', 'linear', 'agent-access.enc')
  setTestUserData(userData)
  setSecretStore(fakeKeychain())
})

describe('sealed agent access', () => {
  it('is off until Pod seals it on, and the file holds no plain value', async () => {
    const { store } = await freshAccess()
    expect(store.readSealedLinearAgentAccess()).toBe(false)

    store.writeSealedLinearAgentAccess(true)

    expect(store.readSealedLinearAgentAccess()).toBe(true)
    expect(readFileSync(accessFile, 'utf8')).not.toContain('agent-access:on')
    expect((await freshAccess()).store.readSealedLinearAgentAccess()).toBe(true)
  })

  it.each([
    ['the plain value', 'pod-linear-agent-access:on'],
    ['JSON', '{"enabled":true}'],
    ['an empty file', '']
  ])('reads a file holding %s as off', async (_what, bytes) => {
    const { store } = await freshAccess()
    store.writeSealedLinearAgentAccess(false)
    writeFileSync(accessFile, bytes)

    expect((await freshAccess()).store.readSealedLinearAgentAccess()).toBe(false)
  })

  it('ignores podLinearAgentAccess in the settings file', async () => {
    const { access, installPodLinear } = await freshAccess()
    const editedSettings = { podLinear: true, podLinearAgentAccess: true }
    installPodLinear({ getSettings: () => editedSettings, updateSettings: () => {} })

    expect(access.isPodLinearAgentAccessOn()).toBe(false)
  })

  it('stays off when the keychain cannot seal', async () => {
    setSecretStore(fakeKeychain({ isEncryptionAvailable: () => false }))
    const { access, installPodLinear } = await freshAccess()
    installPodLinear({ getSettings: () => ({}), updateSettings: () => {} })

    expect(() => access.writePodLinearAgentAccess(true)).toThrow()
    expect(access.isPodLinearAgentAccessOn()).toBe(false)
  })
})
