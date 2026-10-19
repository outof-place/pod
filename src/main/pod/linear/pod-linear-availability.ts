// Fork-only (Pod): whether Linear is on in this runtime, and why not. Three things must hold: the
// build compiles the feature in, the user turned podLinear on, and @linear/sdk is packaged.
import { createRequire } from 'node:module'
import { POD_LINEAR } from '../../../shared/product/features'
import type { LinearUnavailableReason } from '../../../shared/linear/workspace-types'

export type PodLinearAvailability =
  | { available: true }
  | { available: false; reason: LinearUnavailableReason }

export type PodLinearEnabledSetting = { read(): boolean; write(enabled: boolean): void }

let enabledSetting: PodLinearEnabledSetting | null = null
let sdkPackaged: boolean | undefined

/** Installed at startup over the settings store; until then Linear reads as off. */
export function setPodLinearEnabledSetting(setting: PodLinearEnabledSetting | null): void {
  enabledSetting = setting
}

/** Writes podLinear and returns what it reads back. */
export function writePodLinearEnabled(enabled: boolean): boolean {
  if (!enabledSetting) {
    throw new Error('Linear has no settings store yet.')
  }
  enabledSetting.write(enabled)
  return enabledSetting.read()
}

// Why resolve and not load: the SDK is ~2.6 MB to parse, and a status poll must not pay for it.
// Same base as linear-sdk.ts's loader, so both see the same packaged node_modules.
function isLinearSdkPackaged(): boolean {
  if (sdkPackaged === undefined) {
    try {
      createRequire(__filename).resolve('@linear/sdk')
      sdkPackaged = true
    } catch {
      sdkPackaged = false
    }
  }
  return sdkPackaged
}

export function podLinearAvailability(
  feature: boolean = POD_LINEAR,
  sdkPresent: () => boolean = isLinearSdkPackaged
): PodLinearAvailability {
  if (!feature) {
    return { available: false, reason: 'feature-off' }
  }
  if (enabledSetting?.read() !== true) {
    return { available: false, reason: 'setting-off' }
  }
  return sdkPresent() ? { available: true } : { available: false, reason: 'sdk-missing' }
}

export function podLinearUnavailableMessage(reason: LinearUnavailableReason): string {
  switch (reason) {
    case 'feature-off':
      return 'Linear is not part of this Pod build.'
    case 'setting-off':
      return "Linear is off in Pod. The user can turn it on in Pod's Linear settings."
    case 'sdk-missing':
      return "This Pod build doesn't include the Linear SDK."
  }
}
