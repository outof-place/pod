import { app } from 'electron'
import { sendToPodUi } from '../pod/ui-host/pod-ui-host-bridge'

let unreadCount = 0

function applyDockBadge(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const label = unreadCount === 0 ? '' : unreadCount > 99 ? '99+' : String(unreadCount)
  app.dock?.setBadge(label)
  // Fork-only (Pod): a one-app runtime has no Dock tile; PodNative's tile shows the count.
  sendToPodUi({ type: 'badge', label })
}

export function setUnreadDockBadgeCount(count: number): void {
  if (process.platform !== 'darwin') {
    return
  }

  unreadCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0

  applyDockBadge()
}
