import {
  isHiddenRendererPtyViewGated,
  recordHiddenRendererPtyDataDrop
} from '../../pty-hidden-delivery-gate'
import type { PendingPtyData } from '../../pty-pending-data-drain-queue'
import {
  makePtyDataPayload,
  sendModelRestoreNeededMarker,
  sendPtyDataToRenderer,
  sendSkippedViewQueries
} from './payload'
import type { PtyIpcSession } from '../session'

/** The stamp for bytes main ingests now, read in the same tick as the runtime's reply-ownership
 *  decision (shouldModelAnswerHiddenPtyQueries), which answers only while the view is gated. */
export function isRendererPtyViewGatedForIngestion(session: PtyIpcSession, id: string): boolean {
  return isHiddenRendererPtyViewGated(id, session.getSettings?.())
}

/** Drops a gated entry: its queries were answered outside the view, which restores from main. */
export function dropViewGatedPendingPtyData(
  session: PtyIpcSession,
  id: string,
  pending: PendingPtyData
): void {
  if (pending.projectionAdmissionIds) {
    session.sshOutputIntake?.transferProjections(pending.projectionAdmissionIds, 'hidden-drop')
  }
  if (recordHiddenRendererPtyDataDrop(id, pending.data.length).shouldEmitRestoreMarker) {
    sendModelRestoreNeededMarker(
      session,
      id,
      'hidden-drop',
      session.runtime?.getPtyOutputSequence(id)
    )
  }
}

/** Runs before bytes stamped `viewGatedAtIngestion` join `id`'s pending entry, so one entry
 *  never mixes stamps. Returns the entry the bytes may join. */
export function settlePendingViewGateStamp(
  session: PtyIpcSession,
  id: string,
  viewGatedAtIngestion: boolean
): PendingPtyData | undefined {
  const pending = session.pendingData.get(id)
  if (!pending || (pending.viewGatedAtIngestion === true) === viewGatedAtIngestion) {
    return pending
  }
  if (viewGatedAtIngestion) {
    // The view went gated before it parsed these bytes: answer their queries now, then
    // treat them as gated so a quick reveal cannot make the view answer them again.
    sendSkippedViewQueries(session, id, pending.data)
    const settled: PendingPtyData = {
      ...pending,
      ...(pending.droppedOutput === true ? { data: '' } : {}),
      viewGatedAtIngestion: true
    }
    session.setPendingPtyData(id, settled)
    return settled
  }
  // Revealed with gated bytes still queued: their queries were answered outside the view,
  // so they go to sidecars only (the view restores from main) and fresh bytes start anew.
  session.deletePendingPtyData(id)
  session.pendingOverflowMarkedPtys.delete(id)
  if (pending.droppedOutput !== true && pending.data && session.rendererPtyDispatcherReady) {
    sendPtyDataToRenderer(
      session,
      id,
      makePtyDataPayload(
        id,
        pending.data,
        pending.startSeq,
        pending.containsBackgroundOutput,
        pending.rawLength,
        pending.transformed
      ),
      pending.projectionAdmissionIds,
      true
    )
  } else {
    dropViewGatedPendingPtyData(session, id, pending)
  }
  return undefined
}
