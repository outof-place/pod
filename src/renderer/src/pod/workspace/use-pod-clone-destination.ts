// Fork-only (Pod): local clones default to <root>/<owner>; Orca appends the repo folder.
import { useEffect, useRef } from 'react'
import { getDefaultCloneParent } from '@/components/sidebar/clone-defaults'
import { getPodWorkspaceApi } from './pod-workspace-api-access'
import { usePodWorkspaceEnabled } from './use-pod-workspace-enabled'

const URL_DEBOUNCE_MS = 150

/** True when the destination is still a default (Orca's or ours), so a new one may replace it. */
export function isReplaceableCloneDestination(
  destination: string,
  defaults: { podDefault: string | null; orcaDefault: string }
): boolean {
  const current = destination.trim()
  return current === '' || current === defaults.podDefault || current === defaults.orcaDefault
}

export function usePodCloneDestination({
  step,
  cloneUrl,
  cloneDestination,
  setCloneDestination,
  workspaceDir,
  isLocalClone
}: {
  step: string
  cloneUrl: string
  cloneDestination: string
  setCloneDestination: (value: string) => void
  workspaceDir: string | null | undefined
  isLocalClone: boolean
}): void {
  const enabled = usePodWorkspaceEnabled()
  const podDefaultRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || step !== 'clone' || !isLocalClone) {
      return
    }
    const orcaDefault = workspaceDir ? getDefaultCloneParent(workspaceDir) : ''
    // Why: a folder the user picked or typed is never overwritten.
    if (
      !isReplaceableCloneDestination(cloneDestination, {
        podDefault: podDefaultRef.current,
        orcaDefault
      })
    ) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void getPodWorkspaceApi()
        ?.getCloneDestination(cloneUrl.trim())
        .then((destination) => {
          if (!cancelled && destination) {
            podDefaultRef.current = destination
            setCloneDestination(destination)
          }
        })
        .catch(() => undefined)
    }, URL_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cloneDestination, cloneUrl, enabled, isLocalClone, setCloneDestination, step, workspaceDir])
}
