import { describe, expect, it } from 'vitest'
import {
  ORCA_IMPORT_SOURCE_DIR_ENV,
  ORCA_IMPORT_SOURCE_HOME_ENV,
  orcaImportInstanceBlock,
  resolveOrcaImportLocation,
  type OrcaImportLocationInput
} from './orca-import-location'

const base: OrcaImportLocationInput = {
  legacyUserDataName: 'orca',
  legacyHomeDirName: null,
  appDataPath: '/Users/someone/Library/Application Support',
  homePath: '/Users/someone',
  accountHome: '/Users/someone',
  instanceBlock: null,
  env: {},
  podUserData: '/Users/someone/Library/Application Support/Pod'
}

describe('resolveOrcaImportLocation', () => {
  it("reads the account's Orca only in the user's own Pod", () => {
    expect(resolveOrcaImportLocation(base)).toEqual({
      kind: 'source',
      location: {
        userData: '/Users/someone/Library/Application Support/orca',
        legacyHome: null,
        sharesPodHome: true,
        own: true
      }
    })
  })

  it('names Orca’s own home folder once decouple gives Pod its own', () => {
    expect(resolveOrcaImportLocation({ ...base, legacyHomeDirName: '.orca' })).toMatchObject({
      location: { legacyHome: '/Users/someone/.orca', sharesPodHome: false }
    })
  })

  it('ignores the test source variable in the user’s own Pod', () => {
    const resolved = resolveOrcaImportLocation({
      ...base,
      env: { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/private/tmp/fake-orca' }
    })
    expect(resolved).toMatchObject({
      location: { userData: '/Users/someone/Library/Application Support/orca' }
    })
  })

  it('refuses any other Pod without an explicit synthetic source', () => {
    for (const instanceBlock of ['e2e', 'dev-build', 'custom-profile', 'not-checked']) {
      expect(resolveOrcaImportLocation({ ...base, instanceBlock })).toEqual({
        kind: 'refused',
        reason: 'not-the-users-pod'
      })
    }
  })

  it('reads only the synthetic source in a test Pod', () => {
    const resolved = resolveOrcaImportLocation({
      ...base,
      instanceBlock: 'e2e',
      env: {
        [ORCA_IMPORT_SOURCE_DIR_ENV]: '/private/tmp/run/orca',
        [ORCA_IMPORT_SOURCE_HOME_ENV]: '/private/tmp/run/home/.orca'
      }
    })
    expect(resolved).toEqual({
      kind: 'source',
      location: {
        userData: '/private/tmp/run/orca',
        legacyHome: '/private/tmp/run/home/.orca',
        sharesPodHome: false,
        own: false
      }
    })
  })

  it('refuses a test source inside the account’s home, the real profile included', () => {
    for (const env of [
      { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/Users/someone/Library/Application Support/orca' },
      { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/Users/someone/Documents/copy-of-orca' },
      {
        [ORCA_IMPORT_SOURCE_DIR_ENV]: '/private/tmp/run/orca',
        [ORCA_IMPORT_SOURCE_HOME_ENV]: '/Users/someone/.orca'
      }
    ]) {
      expect(resolveOrcaImportLocation({ ...base, instanceBlock: 'e2e', env })).toEqual({
        kind: 'refused',
        reason: 'source-is-the-real-profile'
      })
    }
  })

  it('refuses a test source when the account’s home is unknown', () => {
    expect(
      resolveOrcaImportLocation({
        ...base,
        instanceBlock: 'e2e',
        accountHome: null,
        env: { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/private/tmp/run/orca' }
      })
    ).toEqual({ kind: 'refused', reason: 'source-is-the-real-profile' })
  })

  it('never reads this Pod’s own profile as Orca’s', () => {
    expect(resolveOrcaImportLocation({ ...base, legacyUserDataName: 'Pod' })).toEqual({
      kind: 'refused',
      reason: 'source-is-this-pod'
    })
    expect(
      resolveOrcaImportLocation({
        ...base,
        instanceBlock: 'e2e',
        podUserData: '/private/tmp/run/Pod',
        env: { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/private/tmp/run/Pod' }
      })
    ).toEqual({ kind: 'refused', reason: 'source-is-this-pod' })
  })

  it('refuses a build without Orca in its identity', () => {
    expect(resolveOrcaImportLocation({ ...base, legacyUserDataName: null })).toEqual({
      kind: 'refused',
      reason: 'no-legacy-identity'
    })
  })

  it('refuses appData’s real Orca in an E2E launch with an isolated HOME', () => {
    // Electron's appData comes from the user database, so an isolated HOME leaves it on the account.
    const e2e = {
      ...base,
      homePath: '/private/tmp/run/home',
      instanceBlock: orcaImportInstanceBlock(
        { ORCA_E2E_USER_DATA_DIR: '/private/tmp/run' },
        () => null
      )
    }
    expect(e2e.instanceBlock).toBe('e2e')
    expect(resolveOrcaImportLocation(e2e)).toEqual({ kind: 'refused', reason: 'not-the-users-pod' })
    expect(
      resolveOrcaImportLocation({
        ...e2e,
        env: { [ORCA_IMPORT_SOURCE_DIR_ENV]: '/Users/someone/Library/Application Support/orca' }
      })
    ).toEqual({ kind: 'refused', reason: 'source-is-the-real-profile' })
  })
})

describe('orcaImportInstanceBlock', () => {
  it('counts every E2E launch out, whatever the hook write check says', () => {
    expect(orcaImportInstanceBlock({ ORCA_E2E_USER_DATA_DIR: '/x' }, () => null)).toBe('e2e')
    expect(orcaImportInstanceBlock({ POD_E2E_USER_DATA_DIR: '/x' }, () => null)).toBe('e2e')
    expect(orcaImportInstanceBlock({}, () => 'dev-build')).toBe('dev-build')
    expect(orcaImportInstanceBlock({}, () => null)).toBeNull()
  })
})
