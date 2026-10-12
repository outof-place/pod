// Fork-only (Pod): keybindings.effective and clientEvents' `keybindings` opt-in; off without Pod's identity.
import type { z } from 'zod'
import { getProductIdentity } from '../../product-identity/product-identity'
import type {
  PodEffectiveKeybindings,
  PodKeybindingsChangedEvent,
  PodKeybindingsReadyFields
} from '../../../shared/pod-keybindings-event'
import type { PodClientEventsSubscribeParams } from '../../../shared/rpc-contract/pod-client-events-params'
import { PodKeybindingsHub } from './pod-keybindings-hub'

type SubscribeParams = z.output<typeof PodClientEventsSubscribeParams>

let hub: PodKeybindingsHub | null = null

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    return false
  }
}

/** Pod builds only. `POD_KEYBINDINGS_RPC=0|1` overrides the identity, for tests. */
export function isPodKeybindingsRpcEnabled(
  env: NodeJS.ProcessEnv = process.env,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (env.POD_KEYBINDINGS_RPC === '0') {
    return false
  }
  return env.POD_KEYBINDINGS_RPC === '1' || hasIdentity()
}

/** Idempotent; reads and watches nothing until asked. `path`: the file KeybindingService uses. */
export function installPodKeybindings(
  path: () => string,
  enabled: boolean = isPodKeybindingsRpcEnabled(),
  platform: NodeJS.Platform = process.platform
): void {
  if (!hub && enabled) {
    hub = new PodKeybindingsHub(path, platform)
  }
}

export function uninstallPodKeybindingsForTests(): void {
  hub = null
}

export function readPodKeybindings(): PodEffectiveKeybindings {
  if (!hub) {
    throw new Error('keybindings.effective is off in this build.')
  }
  return hub.read()
}

/** Joins one client events subscription to the file watch; null when it didn't opt in or Pod is off. */
export function subscribePodKeybindings(
  params: SubscribeParams | undefined,
  emit: (event: PodKeybindingsChangedEvent) => void
): (() => void) | null {
  if (!hub || params?.keybindings !== true) {
    return null
  }
  let warned = false
  return hub.subscribe(
    (keybindings) => emit({ type: 'keybindingsChanged', ...keybindings }),
    (error) => {
      if (!warned) {
        warned = true
        console.warn('[pod-keybindings] watching the keybindings file failed:', error)
      }
    }
  )
}

export function podKeybindingsReadyFields(stop: (() => void) | null): PodKeybindingsReadyFields {
  return stop ? { keybindings: true } : {}
}
