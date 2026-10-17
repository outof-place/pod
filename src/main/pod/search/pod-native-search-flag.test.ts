import { describe, expect, it } from 'vitest'
import { isPodNativeSearchEnabled } from './pod-native-search-flag'
import {
  applyPodIndexedSearchPtyEnv,
  setPodIndexedSearchEnabled
} from './pod-indexed-search-pty-env'

describe('isPodNativeSearchEnabled', () => {
  it('is off unless the setting is on', () => {
    expect(isPodNativeSearchEnabled({}, {}, 'darwin')).toBe(false)
    expect(isPodNativeSearchEnabled({ experimentalPodNativeSearch: false }, {}, 'darwin')).toBe(false)
    expect(isPodNativeSearchEnabled({ experimentalPodNativeSearch: true }, {}, 'darwin')).toBe(true)
  })

  it('takes ORCA_POD_SEARCH over the setting, never on Windows', () => {
    expect(isPodNativeSearchEnabled({}, { ORCA_POD_SEARCH: '1' }, 'darwin')).toBe(true)
    expect(
      isPodNativeSearchEnabled({ experimentalPodNativeSearch: true }, { ORCA_POD_SEARCH: '0' }, 'darwin')
    ).toBe(false)
    expect(isPodNativeSearchEnabled({ experimentalPodNativeSearch: true }, {}, 'win32')).toBe(false)
  })
})

describe('applyPodIndexedSearchPtyEnv', () => {
  it('sets POD_INDEXED_SEARCH while search is on and drops an inherited one while off', () => {
    let on = false
    setPodIndexedSearchEnabled(() => on)
    const off: Record<string, string> = { POD_INDEXED_SEARCH: '1', PATH: '/usr/bin' }
    applyPodIndexedSearchPtyEnv(off)
    expect(off).toEqual({ PATH: '/usr/bin' })
    on = true
    const env: Record<string, string> = { PATH: '/usr/bin' }
    applyPodIndexedSearchPtyEnv(env)
    expect(env).toEqual({ PATH: '/usr/bin', POD_INDEXED_SEARCH: '1' })
  })
})
