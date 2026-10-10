// Fork-only (Pod): the downloads of one-app's offscreen pages, as PodNative's list shows them. The
// browser manager reports a download in three kinds of events; each becomes the whole record.
import type { PodBrowserDownloadEvent } from './pod-browser-pane-hooks'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'

type DownloadMessage = Extract<PodBrowserPaneServerMessage, { type: 'browserDownload' }>
// Finished downloads PodNative still lists; the oldest go first past this.
const MAX_KEPT = 50

export class PaneDownloads {
  private readonly records = new Map<string, DownloadMessage>()

  note(event: PodBrowserDownloadEvent): DownloadMessage | null {
    const known = this.records.get(event.downloadId)
    let next: DownloadMessage
    if (event.kind === 'requested') {
      next = {
        type: 'browserDownload',
        pageId: event.browserPageId,
        downloadId: event.downloadId,
        filename: event.filename,
        state: 'downloading',
        receivedBytes: known?.receivedBytes ?? 0,
        totalBytes: event.totalBytes,
        savePath: event.savePath,
        error: null
      }
    } else if (!known) {
      // Progress or an end for a download whose start never came: nothing to name it by.
      return null
    } else if (event.kind === 'progress') {
      next = {
        ...known,
        state: event.state === 'interrupted' ? 'interrupted' : 'downloading',
        receivedBytes: event.receivedBytes,
        totalBytes: event.totalBytes
      }
    } else {
      next = {
        ...known,
        state: event.status,
        savePath: event.savePath ?? known.savePath,
        error: event.error
      }
    }
    this.records.delete(event.downloadId)
    this.records.set(event.downloadId, next)
    while (this.records.size > MAX_KEPT) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.records.delete(oldest)
    }
    return next
  }

  /** Every download, oldest first: what a newly attached PodNative is told. */
  all(): DownloadMessage[] {
    return [...this.records.values()]
  }
}
