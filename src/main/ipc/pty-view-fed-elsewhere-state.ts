// Parse once: PTYs whose pane xterm left the byte stream under a native view main feeds. The
// renderer asks; the change takes effect only between delivery batches, so a chunk's reply owner
// (decided at ingestion) and its delivery (decided at send) always agree. The hidden-delivery
// gate reads it in rendererPtyViewDelivery.
const requestedPtys = new Set<string>()
const fedElsewherePtys = new Set<string>()
// Resolves a renderer's pending request once the change took effect (or the PTY's state cleared).
const appliedWaiters = new Map<string, () => void>()
// Whether delivery still queues bytes for the PTY; installed by the delivery session.
let hasQueuedBytes: (id: string) => boolean = () => false
let reportedFlipWhileQueued = false

/** Queued bytes keep the reply owner the set gave them at ingestion, so the set must never
 *  flip while any wait; the delivery session tells the state when that is. */
export function setRendererPtyViewFedElsewhereQueueProbe(probe: (id: string) => boolean): void {
  hasQueuedBytes = probe
}

export function isRendererPtyViewFedElsewhere(id: string): boolean {
  return fedElsewherePtys.has(id)
}

/** Resolves once main delivers by the new state: every chunk flagged before it was sent first. */
export function requestRendererPtyViewFedElsewhere(
  id: string,
  fedElsewhere: boolean,
  atBatchBoundary: boolean
): Promise<void> {
  if (fedElsewhere) {
    requestedPtys.add(id)
  } else {
    requestedPtys.delete(id)
  }
  if (atBatchBoundary && applyRendererPtyViewFedElsewhere(id)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const previous = appliedWaiters.get(id)
    appliedWaiters.set(id, () => {
      previous?.()
      resolve()
    })
  })
}

/** At a delivery-batch boundary (nothing pending for the PTY): the request takes effect.
 *  Returns false, leaving the request pending, if a caller tries it with bytes still queued. */
export function applyRendererPtyViewFedElsewhere(id: string): boolean {
  const fedElsewhere = requestedPtys.has(id)
  if (fedElsewhere !== fedElsewherePtys.has(id) && hasQueuedBytes(id)) {
    if (!reportedFlipWhileQueued) {
      reportedFlipWhileQueued = true
      console.error('[pty] parse-once state flip refused while bytes are queued for the PTY')
    }
    return false
  }
  if (fedElsewhere) {
    fedElsewherePtys.add(id)
  } else {
    fedElsewherePtys.delete(id)
  }
  settleWaiter(id)
  return true
}

export function clearRendererPtyViewFedElsewhere(id: string): void {
  requestedPtys.delete(id)
  fedElsewherePtys.delete(id)
  settleWaiter(id)
}

export function clearAllRendererPtyViewFedElsewhere(): void {
  reportedFlipWhileQueued = false
  requestedPtys.clear()
  fedElsewherePtys.clear()
  for (const id of appliedWaiters.keys()) {
    settleWaiter(id)
  }
}

function settleWaiter(id: string): void {
  const waiter = appliedWaiters.get(id)
  appliedWaiters.delete(id)
  waiter?.()
}
