// Fork-only (Pod): whether this desktop build shows OrbStack (macOS, Pod identity or env gate).
import { useEffect, useState } from 'react'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getPodOrbstackApi } from './pod-orbstack-api-access'

let enabled = false
let asked = false
const listeners = new Set<() => void>()

async function refreshEnabled(): Promise<void> {
  let next = false
  try {
    next = (await getPodOrbstackApi()?.isEnabled()) === true
  } catch {
    next = false
  }
  if (next !== enabled) {
    enabled = next
    for (const listener of listeners) {
      listener()
    }
  }
}

/** The main process owns the gate, and it cannot change while Pod runs, so it is asked once. */
export function usePodOrbstackEnabled(): boolean {
  const [value, setValue] = useState(enabled)
  useEffect(() => {
    const listener = (): void => setValue(enabled)
    listeners.add(listener)
    // Why: the module value may have changed between this render and the subscription.
    listener()
    if (!asked && isMacUserAgent() && !isWebClientLocation()) {
      asked = true
      void refreshEnabled()
    }
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return value
}
