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
      appId: 'space.outofplace.pod',
      cliName: 'pod-cli',
      userDataName: 'pod',
      keychainName: 'pod',
      protocols: ['pod'],
      updateFeed: { provider: 'github', owner: 'outof-place', repo: 'pod' },
      legacyProfile: { userDataName: 'orca', keychainName: 'orca' }
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
    const withBadFeed = { ...Object(repoIdentity), updateFeed: { provider: 'generic' } }
    expect(() => parseProductIdentity(withBadFeed)).toThrow(/updateFeed/)
  })

  it('allows a product without its own update feed or legacy profile', () => {
    const minimal = { ...Object(repoIdentity), updateFeed: null, legacyProfile: null }
    expect(parseProductIdentity(minimal)).toMatchObject({ updateFeed: null, legacyProfile: null })
  })

  it('finds the app bundle that owns the main executable', () => {
    expect(appBundlePathFromExecPath('/Applications/Pod.app/Contents/MacOS/Pod')).toBe(
      '/Applications/Pod.app'
    )
    expect(appBundlePathFromExecPath('/usr/local/bin/node')).toBeNull()
  })
})
