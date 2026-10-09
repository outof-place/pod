// Fork-only (Pod): whether this desktop build manages a workspace root (macOS, Pod gate on).
import { useEffect, useState } from 'react'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { getPodWorkspaceApi } from './pod-workspace-api-access'

let enabled = false
const listeners = new Set<() => void>()

async function refreshEnabled(): Promise<void> {
  let next = false
  try {
    next = (await getPodWorkspaceApi()?.isEnabled()) === true
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

/** The main process owns the gate (identity, env, setting); re-asked when the setting flips. */
export function usePodWorkspaceEnabled(): boolean {
  const explicitSetting = useAppStore((state) => state.settings?.experimentalPodWorkspace)
  const [value, setValue] = useState(enabled)
  useEffect(() => {
    const listener = (): void => setValue(enabled)
    listeners.add(listener)
    // Why: the module value may have changed between this render and the subscription.
    listener()
    if (isMacUserAgent() && !isWebClientLocation()) {
      void refreshEnabled()
    }
    return () => {
      listeners.delete(listener)
    }
  }, [explicitSetting])
  return value
}
