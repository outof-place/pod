import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetTerminalModelQueryAuthorityForTest,
  clearNativeWindowsConptyPty,
  isNativeWindowsConptyPty,
  isNativeWindowsLocalPtySpawn,
  isTerminalModelQueryAuthorityEnabled,
  markNativeWindowsConptyPty,
  shouldModelAnswerHiddenPtyQueries
} from './terminal-model-query-authority'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  clearHiddenRendererPtyDeliveryState,
  markHiddenRendererPty,
  rendererPtyViewDelivery,
  resetRendererScopedHiddenPtyDeliveryState,
  setRendererPtyDeliveryInterest
} from '../ipc/pty-hidden-delivery-gate'
import {
  applyRendererPtyViewFedElsewhere,
  requestRendererPtyViewFedElsewhere
} from '../ipc/pty-view-fed-elsewhere-state'

const ALL_ON = {
  terminalMainSideEffectAuthority: true,
  terminalHiddenDeliveryGate: true,
  terminalModelQueryAuthority: true
}

afterEach(() => {
  _resetTerminalModelQueryAuthorityForTest()
  _resetHiddenRendererPtyDeliveryGateForTest()
})

describe('isTerminalModelQueryAuthorityEnabled', () => {
  it('defaults on, including for absent settings', () => {
    expect(isTerminalModelQueryAuthorityEnabled(ALL_ON)).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled({})).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled(null)).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled(undefined)).toBe(true)
  })

  it('is an independent off switch for the responder alone', () => {
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalModelQueryAuthority: false })
    ).toBe(false)
  })

  it('requires both Phase-4 gate switches — no marks exist without them', () => {
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalHiddenDeliveryGate: false })
    ).toBe(false)
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalMainSideEffectAuthority: false })
    ).toBe(false)
  })
})

describe('shouldModelAnswerHiddenPtyQueries', () => {
  const answer = (ptyId: string, overrides: Record<string, boolean> = {}): boolean =>
    shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: { ...ALL_ON, ...overrides },
      hasRemoteViewSubscriber: false
    })

  it('answers only for hidden-marked PTYs (the delivery decision is the reply decision)', () => {
    expect(answer('pty-1')).toBe(false)
    markHiddenRendererPty('pty-1')
    expect(answer('pty-1')).toBe(true)
    expect(answer('pty-other')).toBe(false)
  })

  it('keeps answering under renderer delivery interest (the chunk reaches sidecars, not the view)', () => {
    markHiddenRendererPty('pty-1')
    setRendererPtyDeliveryInterest('pty-1', true)
    expect(answer('pty-1')).toBe(true)
    setRendererPtyDeliveryInterest('pty-1', false)
    expect(answer('pty-1')).toBe(true)
  })

  it('yields while a remote view subscriber is attached', () => {
    markHiddenRendererPty('pty-1')
    expect(
      shouldModelAnswerHiddenPtyQueries({
        ptyId: 'pty-1',
        settings: ALL_ON,
        hasRemoteViewSubscriber: true
      })
    ).toBe(false)
  })

  it('stays silent under any kill switch', () => {
    markHiddenRendererPty('pty-1')
    expect(answer('pty-1', { terminalModelQueryAuthority: false })).toBe(false)
    expect(answer('pty-1', { terminalHiddenDeliveryGate: false })).toBe(false)
    expect(answer('pty-1', { terminalMainSideEffectAuthority: false })).toBe(false)
  })
})

describe('isNativeWindowsLocalPtySpawn (main-side mirror of isLocalNativeWindowsPty)', () => {
  const base = {
    connectionId: null,
    cwd: 'C:\\repo',
    shellOverride: undefined,
    platform: 'win32' as NodeJS.Platform
  }

  it('matches local native Windows spawns', () => {
    expect(isNativeWindowsLocalPtySpawn(base)).toBe(true)
    expect(isNativeWindowsLocalPtySpawn({ ...base, connectionId: undefined })).toBe(true)
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'C:\\Tools\\powershell.exe' })
    ).toBe(true)
  })

  it('rejects non-Windows hosts', () => {
    expect(isNativeWindowsLocalPtySpawn({ ...base, platform: 'darwin' })).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, platform: 'linux' })).toBe(false)
  })

  it('rejects SSH-backed spawns', () => {
    expect(isNativeWindowsLocalPtySpawn({ ...base, connectionId: 'ssh-1' })).toBe(false)
  })

  it('rejects WSL cwds and WSL shell overrides', () => {
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me' })
    ).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'wsl.exe' })).toBe(false)
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'C:\\Windows\\System32\\wsl.exe' })
    ).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'wsl' })).toBe(false)
  })
})

describe('native-Windows ConPTY spawn record', () => {
  it('marks, reads, and clears per PTY', () => {
    expect(isNativeWindowsConptyPty('pty-1')).toBe(false)
    markNativeWindowsConptyPty('pty-1')
    expect(isNativeWindowsConptyPty('pty-1')).toBe(true)
    expect(isNativeWindowsConptyPty('pty-2')).toBe(false)
    clearNativeWindowsConptyPty('pty-1')
    expect(isNativeWindowsConptyPty('pty-1')).toBe(false)
  })
})

describe('parse once: a view fed elsewhere', () => {
  const answers = (ptyId: string, settings = ALL_ON): boolean =>
    shouldModelAnswerHiddenPtyQueries({ ptyId, settings, hasRemoteViewSubscriber: false })

  it('makes main the responder for a visible PTY whose xterm skips its bytes', async () => {
    expect(rendererPtyViewDelivery('pty-v', ALL_ON)).toBe('parse')
    expect(answers('pty-v')).toBe(false)
    await requestRendererPtyViewFedElsewhere('pty-v', true, true)
    expect(rendererPtyViewDelivery('pty-v', ALL_ON)).toBe('skipXterm')
    expect(answers('pty-v')).toBe(true)
    // Without main as responder xterm keeps parsing: double parse, but replies stay right.
    const noAuthority = { ...ALL_ON, terminalModelQueryAuthority: false }
    expect(rendererPtyViewDelivery('pty-v', noAuthority)).toBe('parse')
    expect(answers('pty-v', noAuthority)).toBe(false)
    expect(
      shouldModelAnswerHiddenPtyQueries({
        ptyId: 'pty-v',
        settings: ALL_ON,
        hasRemoteViewSubscriber: true
      })
    ).toBe(false)
  })

  it('changes only at a delivery-batch boundary, and settles the request there', async () => {
    let applied = false
    void requestRendererPtyViewFedElsewhere('pty-b', true, false).then(() => (applied = true))
    expect(answers('pty-b')).toBe(false)
    await Promise.resolve()
    expect(applied).toBe(false)
    applyRendererPtyViewFedElsewhere('pty-b')
    await Promise.resolve()
    expect(applied).toBe(true)
    expect(answers('pty-b')).toBe(true)
    void requestRendererPtyViewFedElsewhere('pty-b', false, false)
    expect(answers('pty-b')).toBe(true)
    applyRendererPtyViewFedElsewhere('pty-b')
    expect(answers('pty-b')).toBe(false)
  })

  it('settles every pending request when the PTY or the renderer state clears', async () => {
    const settled: string[] = []
    void requestRendererPtyViewFedElsewhere('pty-c', true, false).then(() => settled.push('c1'))
    void requestRendererPtyViewFedElsewhere('pty-c', false, false).then(() => settled.push('c2'))
    void requestRendererPtyViewFedElsewhere('pty-r', true, false).then(() => settled.push('r'))
    clearHiddenRendererPtyDeliveryState('pty-c')
    resetRendererScopedHiddenPtyDeliveryState()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled.sort()).toEqual(['c1', 'c2', 'r'])
  })

  it('leaves a gated PTY to the drop and sidecar paths, one mode at a time', async () => {
    await requestRendererPtyViewFedElsewhere('pty-g', true, true)
    markHiddenRendererPty('pty-g')
    expect(rendererPtyViewDelivery('pty-g', ALL_ON)).toBe('drop')
    setRendererPtyDeliveryInterest('pty-g', true)
    expect(rendererPtyViewDelivery('pty-g', ALL_ON)).toBe('sidecarsOnly')
    expect(answers('pty-g')).toBe(true)
    resetRendererScopedHiddenPtyDeliveryState()
    expect(rendererPtyViewDelivery('pty-g', ALL_ON)).toBe('parse')
    expect(answers('pty-g')).toBe(false)
  })
})
