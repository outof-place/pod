import { useCallback, useEffect, useRef, useState } from 'react'
import type { PodOrbstackStatus } from '../../../../shared/pod-orbstack-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { podOrbstackRpc } from './pod-orbstack-rpc'

// Container CPU and memory change constantly; the page re-reads them while it is open.
const REFRESH_MS = 10_000

export function usePodOrbstackStatus(): {
  status: PodOrbstackStatus | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<PodOrbstackStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const queued = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      // Why: an action that finishes during a poll must still see its own result.
      queued.current = true
      return
    }
    inFlight.current = true
    setLoading(true)
    try {
      const next = await podOrbstackRpc.getStatus()
      if (mounted.current) {
        setStatus(next)
        setError(null)
      }
    } catch (caught) {
      if (mounted.current) {
        setError(extractIpcErrorMessage(caught, String(caught)))
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setLoading(false)
      }
    }
    if (queued.current && mounted.current) {
      queued.current = false
      await refresh()
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }, REFRESH_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  return { status, loading, error, refresh }
}
