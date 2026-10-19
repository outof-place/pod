import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureScreenshot } from './cdp-screenshot'
import { CAPTURE_STILL_SETTLING_MESSAGE } from './cdp-capture-settle'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { setPodBrowserPaneHooks } from '../pod/browser-pane/pod-browser-pane-hooks'

const TIMEOUT_MESSAGE = 'Screenshot timed out — the browser page did not draw a frame.'
const FULL_PAGE = {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: 1280, height: 86948, scale: 1 }
}
const noHold = (): (() => void) => () => {}

// A page whose debugger attaches and detaches for real, and whose captures answer only when told to.
function densePage() {
  let attached = false
  const answers: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  const mock = {
    id: 100,
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true
      }),
      detach: vi.fn(() => {
        attached = false
      }),
      sendCommand: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            answers.push({ resolve, reject })
          })
      )
    }
  }
  return {
    mock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the capture calls.
    page: mock as unknown as WebContents,
    answerAll: (data: string) => answers.splice(0).forEach((answer) => answer.resolve({ data })),
    failAll: (message: string) =>
      answers.splice(0).forEach((answer) => answer.reject(new Error(message)))
  }
}

async function timedOutCapture(page: WebContents): Promise<void> {
  const capture = captureScreenshot(page, FULL_PAGE, noHold)
  const failed = expect(capture).rejects.toThrow(TIMEOUT_MESSAGE)
  await vi.advanceTimersByTimeAsync(9_000)
  await failed
}

describe('a capture that outlives its deadline', () => {
  afterEach(() => {
    setPodBrowserPaneHooks(null)
    vi.useRealTimers()
  })

  it('keeps the page attached until Chromium answers it, so Chromium can put the page back', async () => {
    vi.useFakeTimers()
    const { mock, page, answerAll } = densePage()
    const lease = acquireElectronDebugger(page)

    await timedOutCapture(page)
    lease.release()
    expect(mock.debugger.detach).not.toHaveBeenCalled()

    answerAll('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('makes the next capture wait for it instead of capturing the page mid-restore', async () => {
    vi.useFakeTimers()
    const { mock, page, answerAll } = densePage()
    const lease = acquireElectronDebugger(page)
    await timedOutCapture(page)
    mock.invalidate.mockClear()

    const next = captureScreenshot(page, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(1)
    // Waiting, it keeps asking the page to draw: an undrawn page answers only with a new frame.
    expect(mock.invalidate.mock.calls.length).toBeGreaterThan(5)

    answerAll('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(2)
    answerAll('viewport')
    await expect(next).resolves.toEqual({ data: 'viewport' })
    lease.release()
  })

  it('fails the next capture with a clear message when it still has not answered', async () => {
    vi.useFakeTimers()
    const { mock, page } = densePage()
    const lease = acquireElectronDebugger(page)
    await timedOutCapture(page)

    const next = captureScreenshot(page, { format: 'png' }, noHold)
    const failed = expect(next).rejects.toThrow(CAPTURE_STILL_SETTLING_MESSAGE)
    await vi.advanceTimersByTimeAsync(8_000)
    await failed
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(1)
    lease.release()
  })

  it('keeps the pane on its last frame until Chromium answers, beyond the viewport only', async () => {
    vi.useFakeTimers()
    const releaseFrames = vi.fn()
    const holdFramesForCapture = vi.fn(() => releaseFrames)
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: vi.fn(),
      openLink: vi.fn(() => false),
      passkey: vi.fn(() => null),
      holdFramesForCapture
    })
    const { page, answerAll } = densePage()
    const lease = acquireElectronDebugger(page)

    await timedOutCapture(page)
    expect(holdFramesForCapture).toHaveBeenCalledWith(100)
    expect(releaseFrames).not.toHaveBeenCalled()
    answerAll('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(releaseFrames).toHaveBeenCalledTimes(1)

    const viewport = captureScreenshot(page, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(0)
    answerAll('viewport')
    await expect(viewport).resolves.toEqual({ data: 'viewport' })
    expect(holdFramesForCapture).toHaveBeenCalledTimes(1)
    lease.release()
  })
})

describe('captures at once on one page', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends each only once the one before answered, so none takes a clip view for the page', async () => {
    vi.useFakeTimers()
    const { mock, page, answerAll } = densePage()
    const lease = acquireElectronDebugger(page)
    const mark = { format: 'png', clip: { x: 693, y: 133, width: 176, height: 52, scale: 1 } }
    const region = { format: 'png', clip: { x: 362, y: 302, width: 256, height: 116, scale: 1 } }
    const sent = () => mock.debugger.sendCommand.mock.calls.map((call: unknown[]) => call[1])

    const first = captureScreenshot(page, mark, noHold)
    const second = captureScreenshot(page, { format: 'png' }, noHold)
    const third = captureScreenshot(page, region, noHold)
    await vi.advanceTimersByTimeAsync(100)
    expect(sent()).toEqual([mark])

    answerAll('mark')
    await expect(first).resolves.toEqual({ data: 'mark' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toEqual([mark, { format: 'png' }])

    answerAll('page')
    await expect(second).resolves.toEqual({ data: 'page' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toEqual([mark, { format: 'png' }, region])
    answerAll('region')
    await expect(third).resolves.toEqual({ data: 'region' })
    lease.release()
  })
})

describe("a capture's turn on its page", () => {
  afterEach(() => {
    setPodBrowserPaneHooks(null)
    vi.useRealTimers()
  })

  it('passes to the next capture at once when Chromium answers with an error', async () => {
    vi.useFakeTimers()
    const { mock, page, answerAll, failAll } = densePage()
    const lease = acquireElectronDebugger(page)

    const first = captureScreenshot(page, { format: 'png' }, noHold)
    const second = captureScreenshot(page, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(1)
    const failed = expect(first).rejects.toThrow('Target closed')
    failAll('Target closed')
    await failed
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(2)
    answerAll('second')
    await expect(second).resolves.toEqual({ data: 'second' })
    lease.release()
  })

  it("is the page's own: another page's capture is answered while one here is pending", async () => {
    vi.useFakeTimers()
    const pending = densePage()
    const other = densePage()
    const leases = [acquireElectronDebugger(pending.page), acquireElectronDebugger(other.page)]

    const slow = captureScreenshot(pending.page, { format: 'png' }, noHold)
    const quick = captureScreenshot(other.page, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(0)
    expect(other.mock.debugger.sendCommand).toHaveBeenCalledTimes(1)
    other.answerAll('other')
    await expect(quick).resolves.toEqual({ data: 'other' })

    pending.answerAll('slow')
    await expect(slow).resolves.toEqual({ data: 'slow' })
    leases.forEach((lease) => lease.release())
  })

  it('still ends, and the caller still gets its answer, when releasing the pane throws', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: vi.fn(),
      openLink: vi.fn(() => false),
      passkey: vi.fn(() => null),
      holdFramesForCapture: () => () => {
        throw new Error('pane gone')
      }
    })
    const { mock, page, answerAll } = densePage()
    const lease = acquireElectronDebugger(page)
    const mark = { format: 'png', clip: { x: 693, y: 133, width: 176, height: 52, scale: 1 } }

    const first = captureScreenshot(page, mark, noHold)
    await vi.advanceTimersByTimeAsync(0)
    answerAll('mark')
    await expect(first).resolves.toEqual({ data: 'mark' })

    const next = captureScreenshot(page, { format: 'png' }, noHold)
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.debugger.sendCommand).toHaveBeenCalledTimes(2)
    answerAll('next')
    await expect(next).resolves.toEqual({ data: 'next' })
    expect(warn).toHaveBeenCalledWith('[cdp-capture]', 'pane gone')
    warn.mockRestore()
    lease.release()
  })
})
