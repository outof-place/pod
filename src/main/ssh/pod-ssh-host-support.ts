// Fork-only (Pod): SSH host platforms the Pod build profile ships no payloads for (src/shared/product/features.ts).
import { POD_WINDOWS_SSH_HOSTS } from '../../shared/product/features'
import type { RelayPlatform } from './relay-protocol'

// Why: without this the missing win32 relay reads as a broken install ("try reinstalling").
export function assertPodSupportsSshHostPlatform(platform: RelayPlatform): void {
  if (!POD_WINDOWS_SSH_HOSTS && platform.startsWith('win32-')) {
    throw new Error(
      `Pod does not support Windows SSH hosts (this host is ${platform}). ` +
        'Connect to a Linux or macOS host instead.'
    )
  }
}
