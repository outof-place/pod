import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveOrbstackE2eAnthropic } from './pod-orbstack-tools'

describe('resolveOrbstackE2eAnthropic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pod-orbstack-tools-'))
  const ca = join(dir, 'ca.pem')
  writeFileSync(ca, 'stub CA')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const e2e = {
    ORCA_E2E_USER_DATA_DIR: '/profile',
    POD_E2E_ANTHROPIC_UPSTREAM: '127.0.0.1:8443',
    POD_E2E_ANTHROPIC_UPSTREAM_CA: ca
  }

  it('is off outside an isolated E2E profile', () => {
    expect(resolveOrbstackE2eAnthropic({ ...e2e, ORCA_E2E_USER_DATA_DIR: undefined })).toBeNull()
  })

  it('sends the stub a fake API key by default', async () => {
    const seam = resolveOrbstackE2eAnthropic(e2e)
    expect(seam?.upstream).toEqual({ host: '127.0.0.1', port: 8443, ca: 'stub CA' })
    expect(seam?.credentials.mode()).toBe('api-key')
    expect(await seam?.credentials.authHeaders({ machine: 'pod-x-sbx' })).toEqual({
      'x-api-key': 'pod-e2e-stub-key'
    })
  })

  it('sends a fake bearer in OAuth mode, as the Mac login does', async () => {
    const seam = resolveOrbstackE2eAnthropic({ ...e2e, POD_E2E_ANTHROPIC_MODE: 'oauth' })
    expect(seam?.credentials.mode()).toBe('oauth')
    expect(await seam?.credentials.authHeaders({ machine: 'pod-x-sbx' })).toEqual({
      authorization: 'Bearer pod-e2e-stub-token'
    })
  })
})
