import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const parseOnceRequested = vi.hoisted(() => vi.fn(() => true))
const suspendWebgl = vi.hoisted(() => vi.fn())
const setViewFedElsewhere = vi.hoisted(() =>
  vi.fn(async (_id: string, _fedElsewhere: boolean) => {})
)
const writeTerminalOutput = vi.hoisted(() => vi.fn())

vi.mock('@/lib/pane-manager/native-terminal/native-terminal-requested', () => ({
  isNativeTerminalParseOnceRequested: parseOnceRequested
}))
vi.mock('@/lib/pane-manager/pane-rendering-control', () => ({
  setTerminalWebglSuspendedUnderNativeView: suspendWebgl
}))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({ writeTerminalOutput }))

import {
  createNativeTerminalXtermFeed,
  requestViewFedElsewhere,
  skipViewFedElsewhereOutput
} from './native-terminal-xterm-feed'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

function fakeSession(): ConnectPanePtySession {
  const session = {
    pane: { id: 1, terminal: {} },
    manager: {},
    deps: { isVisibleRef: { current: true } },
    transport: { getPtyId: (): string | null => 'pty-1' },
    disposed: false,
    isHiddenDeliveryGateManagedPty: (ptyId: string | null) => ptyId === 'pty-1',
    canUseHiddenOutputSnapshot: (ptyId: string | null) => ptyId === 'pty-1',
    markHiddenOutputRestoreNeeded: vi.fn(),
    kittyKeyboardModes: { scan: vi.fn() },
    hiddenOutputRestoreNeeded: false,
    hiddenOutputRestoreInFlight: null,
    hiddenOutputRestoreScheduled: false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reads only the fields this fake sets; the session bag is untyped beyond pane/manager/deps/transport.
  return session as unknown as ConnectPanePtySession
}

describe('createNativeTerminalXtermFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    parseOnceRequested.mockReturnValue(true)
    suspendWebgl.mockClear()
    setViewFedElsewhere.mockReset()
    setViewFedElsewhere.mockImplementation(async () => {})
    vi.stubGlobal('window', {
      api: { pty: { setRendererPtyViewFedElsewhere: setViewFedElsewhere } }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks main to feed the view elsewhere and frees WebGL only after the view stayed up', () => {
    const session = fakeSession()
    const feed = createNativeTerminalXtermFeed(session, () => null)
    expect(feed.detach()).toBe(true)
    expect(session.xtermDetachedForNativeView).toBe(true)
    expect(setViewFedElsewhere).toHaveBeenCalledExactlyOnceWith('pty-1', true)
    expect(suspendWebgl).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(suspendWebgl).toHaveBeenCalledWith(session.pane.terminal, true)
  })

  it('keeps xterm on the stream when parse once is off or main cannot restore the PTY', () => {
    parseOnceRequested.mockReturnValue(false)
    const session = fakeSession()
    expect(createNativeTerminalXtermFeed(session, () => null).detach()).toBe(false)
    parseOnceRequested.mockReturnValue(true)
    session.transport.getPtyId = () => 'remote:env@@h1'
    expect(createNativeTerminalXtermFeed(session, () => null).detach()).toBe(false)
    expect(session.xtermDetachedForNativeView).toBeUndefined()
    expect(setViewFedElsewhere).not.toHaveBeenCalled()
  })

  it('restores once main stopped flagging, and resolves once that restore finished', async () => {
    const session = fakeSession()
    const feed = createNativeTerminalXtermFeed(session, () => null)
    feed.detach()
    session.hiddenOutputRestoreNeeded = true
    let mainApplied = (): void => {}
    setViewFedElsewhere.mockImplementationOnce(
      () => new Promise<void>((resolve) => (mainApplied = resolve))
    )
    let caughtUp = false
    void feed.reattach().then(() => (caughtUp = true))
    expect(setViewFedElsewhere).toHaveBeenLastCalledWith('pty-1', false)
    expect(suspendWebgl).toHaveBeenCalledWith(session.pane.terminal, false)
    // Flagged chunks may still arrive until main replies, so xterm stays off the stream.
    await vi.advanceTimersByTimeAsync(50)
    expect(session.xtermDetachedForNativeView).toBe(true)
    expect(session.markHiddenOutputRestoreNeeded).not.toHaveBeenCalled()
    mainApplied()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.xtermDetachedForNativeView).toBe(false)
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(caughtUp).toBe(false)
    session.hiddenOutputRestoreNeeded = false
    await vi.advanceTimersByTimeAsync(20)
    expect(caughtUp).toBe(true)
  })

  it('skips a flagged chunk in xterm but still mirrors its keyboard modes and latches a restore', () => {
    const session = fakeSession()
    session.hiddenOutputRestoreInFlight = Promise.resolve()
    session.hiddenStartupRendererQueryPending = '\x1b['
    skipViewFedElsewhereOutput(session, '\x1b[>1u')
    expect(session.kittyKeyboardModes.scan).toHaveBeenCalledWith('\x1b[>1u')
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalledTimes(1)
    expect(session.hiddenOutputRestoreFreshSnapshotNeeded).toBe(true)
    // Main's model completes and answers a query a hidden chunk began.
    expect(session.hiddenStartupRendererQueryPending).toBe('')
  })

  it('hands xterm the input-mode changes of skipped chunks, also split across chunks', () => {
    const session = fakeSession()
    writeTerminalOutput.mockClear()
    skipViewFedElsewhereOutput(session, 'out\x1b[?2004h\x1b[?1049;1hmore\x1b[?10')
    expect(writeTerminalOutput).toHaveBeenLastCalledWith(
      session.pane.terminal,
      '\x1b[?2004h\x1b[?1h',
      { foreground: true }
    )
    skipViewFedElsewhereOutput(session, '04l tail')
    expect(writeTerminalOutput).toHaveBeenLastCalledWith(session.pane.terminal, '\x1b[?1004l', {
      foreground: true
    })
    skipViewFedElsewhereOutput(session, '\x1b[?25l plain')
    expect(writeTerminalOutput).toHaveBeenCalledTimes(2)
    // Resets clear those modes in xterm too: RIS, DECSTR (split), DECKPAM/DECKPNM.
    skipViewFedElsewhereOutput(session, '\x1b[?9h\x1b=\x1b>bye\x1bc\x1b[!')
    expect(writeTerminalOutput).toHaveBeenLastCalledWith(
      session.pane.terminal,
      '\x1b[?9h\x1b=\x1b>\x1bc',
      { foreground: true }
    )
    skipViewFedElsewhereOutput(session, 'p')
    expect(writeTerminalOutput).toHaveBeenLastCalledWith(session.pane.terminal, '\x1b[!p', {
      foreground: true
    })
  })

  it('rejoins a hidden pane without a restore, and clears the old PTY on a rebind', async () => {
    const session = fakeSession()
    const feed = createNativeTerminalXtermFeed(session, () => null)
    feed.detach()
    session.deps.isVisibleRef.current = false
    await feed.reattach()
    expect(setViewFedElsewhere.mock.calls).toEqual([
      ['pty-1', true],
      ['pty-1', false]
    ])
    expect(session.markHiddenOutputRestoreNeeded).not.toHaveBeenCalled()
    session.deps.isVisibleRef.current = true
    feed.detach()
    session.transport.getPtyId = () => 'pty-2'
    await requestViewFedElsewhere(session, true)
    expect(setViewFedElsewhere.mock.calls.slice(-2)).toEqual([
      ['pty-1', false],
      ['pty-2', true]
    ])
  })
})
