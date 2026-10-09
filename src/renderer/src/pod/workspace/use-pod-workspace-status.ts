import { useCallback, useEffect, useRef, useState } from 'react'
import type { PodWorkspaceStatus } from '../../../../shared/pod-workspace-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getPodWorkspaceApi } from './pod-workspace-api-access'

export type PodWorkspaceStatusState = {
  status: PodWorkspaceStatus | null
  loading: boolean
  error: string | null
  refresh: (force: boolean) => Promise<void>
}

/** Loads the health snapshot when the pane mounts or the root changes, never in the background. */
export function usePodWorkspaceStatus(rootSetting: string | undefined): PodWorkspaceStatusState {
  const [status, setStatus] = useState<PodWorkspaceStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: a slow snapshot for the previous root must not overwrite the newer one.
  const generationRef = useRef(0)

  const refresh = useCallback(async (force: boolean): Promise<void> => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const next = (await getPodWorkspaceApi()?.getStatus({ refresh: force })) ?? null
      if (generation === generationRef.current) {
        setStatus(next)
      }
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(extractIpcErrorMessage(caught, String(caught)))
      }
    } finally {
      if (generation === generationRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh(false)
  }, [refresh, rootSetting])

  return { status, loading, error, refresh }
}
