import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'

/**
 * pod-rootd: claude-acc's one root helper (fans, lid-closed awake, sysctls), a daemonService of
 * Pod.app whose BundleProgram is the payload's pod-rootd. Only Pod's main process can register it
 * (SMAppService resolves the plist in the caller's bundle); pod-rootctl, next to it, drives it.
 */
export const ACC_ROOTD_CTL = 'pod-rootctl'

/** Contents/Library/LaunchDaemons/<appId>.rootd.plist, as the payload ships it. */
export function accRootdServiceName(appId: string): string {
  return `${appId}.rootd.plist`
}

/**
 * Puts back what pod-rootd changed as root (fans auto, sleep, sysctls, shaper, Spotlight list):
 * unregistering only stops the daemon, and a disabled sleep would outlive it.
 */
export function restoreAccRootDefaults(
  run: (spec: ProcessSpec) => Promise<ProcessResult>,
  payloadDir: string
): Promise<ProcessResult> {
  return run({ program: join(payloadDir, ACC_ROOTD_CTL), args: ['restore'], timeoutMs: 60_000 })
}
