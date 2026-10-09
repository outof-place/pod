import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePodDistroConfig,
  POD_DISTRO_IDENTITY_ENV,
  PRODUCT_IDENTITY_RESOURCE,
  readPodDistroConfig
} from './pod-distro-config'

const IDENTITY = {
  formatVersion: 1,
  displayName: 'Pod',
  bundledPlugins: { publishers: ['outof-place'], idPrefix: 'pod-', enablePluginSystem: true },
  claudeAcc: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Pod distro config', () => {
  it('reads the bundled plugin policy and the claude-acc payload from the identity', () => {
    expect(parsePodDistroConfig(IDENTITY)).toEqual({
      bundledPlugins: { publishers: ['outof-place'], idPrefix: 'pod-', enablePluginSystem: true },
      claudeAcc: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' }
    })
    expect(parsePodDistroConfig({ formatVersion: 1 })).toEqual({
      bundledPlugins: null,
      claudeAcc: null
    })
  })

  it.each([
    [{ bundledPlugins: { publishers: ['stablyai'], idPrefix: 'orca-' } }],
    [{ bundledPlugins: { publishers: [], idPrefix: 'pod-' } }],
    [{ bundledPlugins: { publishers: ['outof-place'], idPrefix: 'pod' } }],
    [{ claudeAcc: { payload: '../escape', pluginKey: 'x.y' } }]
  ])('refuses %j', (raw) => {
    expect(() => parsePodDistroConfig(raw)).toThrow()
  })

  it('packaged builds read Resources; unpackaged ones only the explicit test file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-identity-'))
    dirs.push(dir)
    writeFileSync(join(dir, PRODUCT_IDENTITY_RESOURCE), JSON.stringify(IDENTITY))
    expect(
      readPodDistroConfig({ resourcesPath: dir, packaged: true, env: {} }).claudeAcc?.payload
    ).toBe('claude-acc')
    expect(
      readPodDistroConfig({ resourcesPath: dir, packaged: false, env: {} }).claudeAcc
    ).toBeNull()
    const env = { [POD_DISTRO_IDENTITY_ENV]: join(dir, PRODUCT_IDENTITY_RESOURCE) }
    expect(
      readPodDistroConfig({ resourcesPath: null, packaged: false, env }).bundledPlugins?.idPrefix
    ).toBe('pod-')
    expect(
      readPodDistroConfig({ resourcesPath: join(dir, 'missing'), packaged: true, env: {} })
    ).toEqual({ bundledPlugins: null, claudeAcc: null })
  })
})
