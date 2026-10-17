// Fork-only (Pod): what simctl prints, read for the pool. `simctl list devices -j` groups devices
// by runtime identifier; a device's state is simctl's word for it.
import type { SimObservedDevice } from '../pool/sim-pool-ports'

export const SIM_UDID_IN_TEXT = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stateOf(simctlState: unknown): SimObservedDevice['state'] {
  if (simctlState === 'Booted') {
    return 'booted'
  }
  return simctlState === 'Shutdown' ? 'shutdown' : 'transitioning'
}

/** The devices of `simctl list devices -j`, or null when it is not that JSON. */
export function parseSimctlList(stdout: string): SimObservedDevice[] | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(json) || !isRecord(json.devices)) {
    return null
  }
  const devices: SimObservedDevice[] = []
  for (const [runtime, list] of Object.entries(json.devices)) {
    if (!Array.isArray(list)) {
      return null
    }
    for (const device of list) {
      if (!isRecord(device) || typeof device.udid !== 'string' || typeof device.name !== 'string') {
        return null
      }
      devices.push({
        udid: device.udid,
        name: device.name,
        state: stateOf(device.state),
        ...(typeof device.deviceTypeIdentifier === 'string'
          ? { deviceType: device.deviceTypeIdentifier }
          : {}),
        runtime
      })
    }
  }
  return devices
}

const USER_APP = /UIKitApplication:([\w.-]+)\[/g

/** Bundle ids of the user apps `launchctl list` shows running in a booted device. */
export function userAppsRunning(launchctlList: string): string[] {
  const apps = new Set<string>()
  for (const match of launchctlList.matchAll(USER_APP)) {
    if (!match[1].startsWith('com.apple.')) {
      apps.add(match[1])
    }
  }
  return [...apps]
}
