import { describe, expect, it } from 'vitest'
import { PaneDownloads } from './pod-browser-pane-downloads'

const requested = {
  kind: 'requested',
  browserPageId: 'page-1',
  downloadId: 'd1',
  filename: 'report.pdf',
  totalBytes: 1000,
  savePath: '/tmp/report.pdf'
} as const

describe('PaneDownloads', () => {
  it('turns the three kinds of events into one record', () => {
    const downloads = new PaneDownloads()
    expect(downloads.note(requested)).toMatchObject({
      type: 'browserDownload',
      downloadId: 'd1',
      filename: 'report.pdf',
      state: 'downloading',
      receivedBytes: 0
    })
    expect(
      downloads.note({
        kind: 'progress',
        browserPageId: 'page-1',
        downloadId: 'd1',
        receivedBytes: 400,
        totalBytes: 1000,
        state: 'progressing'
      })
    ).toMatchObject({ state: 'downloading', receivedBytes: 400, filename: 'report.pdf' })
    expect(
      downloads.note({
        kind: 'finished',
        browserPageId: 'page-1',
        downloadId: 'd1',
        status: 'completed',
        savePath: null,
        error: null
      })
    ).toMatchObject({ state: 'completed', savePath: '/tmp/report.pdf', receivedBytes: 400 })
    expect(downloads.all()).toHaveLength(1)
  })

  it('ignores progress for a download it never saw start', () => {
    expect(
      new PaneDownloads().note({
        kind: 'progress',
        browserPageId: 'page-1',
        downloadId: 'nope',
        receivedBytes: 1,
        totalBytes: null,
        state: null
      })
    ).toBeNull()
  })

  it('keeps the newest 50', () => {
    const downloads = new PaneDownloads()
    for (let i = 0; i < 60; i++) {
      downloads.note({ ...requested, downloadId: `d${i}` })
    }
    expect(downloads.all()).toHaveLength(50)
    expect(downloads.all()[0].downloadId).toBe('d10')
  })
})
