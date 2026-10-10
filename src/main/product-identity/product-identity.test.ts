import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseProductIdentity,
  PRODUCT_IDENTITY_RESOURCE,
  readProductIdentity
} from './product-identity'
import { appBundlePathFromExecPath } from './product-first-run'

const repoIdentity: unknown = JSON.parse(
  readFileSync(join(__dirname, '../../../product/identity.json'), 'utf8')
)

const dirs: string[] = []
function resourcesWith(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'pod-identity-'))
  dirs.push(dir)
  if (contents !== null) {
    writeFileSync(join(dir, PRODUCT_IDENTITY_RESOURCE), contents)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('product identity', () => {
  it('parses the repo identity file that packaging ships', () => {
    expect(parseProductIdentity(repoIdentity)).toMatchObject({
      displayName: 'Pod',
      appId: 'codes.pod.app',
      packageName: 'pod',
      cliName: 'podx',
      userDataName: 'Pod',
      keychainName: 'Pod',
      protocols: ['pod'],
      homepage: 'https://pod.codes',
      updateFeed: { provider: 'github', owner: 'outof-place', repo: 'pod' },
      stablyServices: false,
      computerUseDisplayName: 'Pod Computer Use',
      homeDirName: '.pod',
      envPrefix: 'POD_',
      legacyProfile: {
        userDataName: 'orca',
        keychainName: 'orca',
        homeDirName: '.orca'
      }
    })
  })

  it('is absent, not an error, when the build ships no identity', () => {
    expect(readProductIdentity(resourcesWith(null))).toBeNull()
  })

  it('rejects a malformed identity instead of booting as Orca', () => {
    expect(() => readProductIdentity(resourcesWith('{"formatVersion":2}'))).toThrow(/formatVersion/)
    const withBadScheme = { ...Object(repoIdentity), protocols: ['Pod:'] }
    expect(() => parseProductIdentity(withBadScheme)).toThrow(/protocols/)
    const withPathEscape = { ...Object(repoIdentity), userDataName: '../orca' }
    expect(() => parseProductIdentity(withPathEscape)).toThrow(/userDataName/)
    const withHomeEscape = { ...Object(repoIdentity), homeDirName: '../.pod' }
    expect(() => parseProductIdentity(withHomeEscape)).toThrow(/homeDirName/)
    const withBadPrefix = { ...Object(repoIdentity), envPrefix: 'pod' }
    expect(() => parseProductIdentity(withBadPrefix)).toThrow(/envPrefix/)
    const withBadFeed = { ...Object(repoIdentity), updateFeed: { provider: 'generic' } }
    expect(() => parseProductIdentity(withBadFeed)).toThrow(/updateFeed/)
  })

  it('defaults optional fields to upstream behaviour', () => {
    const {
      packageName: _packageName,
      homepage: _homepage,
      stablyServices: _stablyServices,
      computerUseDisplayName: _computerUseDisplayName,
      ...required
    } = Object(repoIdentity)
    expect(
      parseProductIdentity({ ...required, updateFeed: null, legacyProfile: null })
    ).toMatchObject({
      packageName: 'pod',
      homepage: null,
      stablyServices: true,
      computerUseDisplayName: null,
      updateFeed: null,
      legacyProfile: null
    })
  })

  it('rejects a non-boolean stablyServices and a non-https homepage', () => {
    expect(() => parseProductIdentity({ ...Object(repoIdentity), stablyServices: 'no' })).toThrow(
      /stablyServices/
    )
    expect(() =>
      parseProductIdentity({ ...Object(repoIdentity), homepage: 'http://pod.codes' })
    ).toThrow(/homepage/)
  })

  it('finds the app bundle that owns the main executable', () => {
    expect(appBundlePathFromExecPath('/Applications/Pod.app/Contents/MacOS/Pod')).toBe(
      '/Applications/Pod.app'
    )
    expect(appBundlePathFromExecPath('/usr/local/bin/node')).toBeNull()
  })
})
