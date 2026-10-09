import { afterEach, describe, expect, it } from 'vitest'
import type { ProductUiIdentity } from '../../../../shared/product-ui-identity'
import { _resetProductUiIdentityForTests } from '@/lib/product-ui-identity'
import {
  getPodNativeTerminalSearchEntries,
  isPodNativeTerminalSetting
} from './pod-native-terminal-setting'

const POD: ProductUiIdentity = {
  displayName: 'Pod',
  cliName: 'podx',
  stablyServices: false,
  repositoryUrl: 'https://github.com/outof-place/pod'
}

function stamp(product: ProductUiIdentity | null, userAgent: string): void {
  Object.assign(globalThis, { window: { api: { product: { get: () => product } } } })
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true })
  _resetProductUiIdentityForTests()
}

describe('Pod native terminal setting', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
    _resetProductUiIdentityForTests()
  })

  it('lives under Terminal in Pod on macOS', () => {
    stamp(POD, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(isPodNativeTerminalSetting()).toBe(true)
    expect(getPodNativeTerminalSearchEntries().map((entry) => entry.title)).toEqual([
      'Native terminal (Ghostty, Metal)'
    ])
  })

  it('stays an Experimental toggle in upstream Orca', () => {
    stamp(null, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(isPodNativeTerminalSetting()).toBe(false)
    expect(getPodNativeTerminalSearchEntries()).toEqual([])
  })
})
