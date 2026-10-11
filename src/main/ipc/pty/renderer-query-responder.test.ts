import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetRendererQueryResponderForTest,
  installRendererQueryResponder,
  noteRendererPtyInput,
  noteRendererViewportClaim,
  setRendererQueryResponderVisible
} from './renderer-query-responder'
import {
  _resetTerminalQueryResponderElectionForTest,
  attachTerminalQueryResponderCandidate,
  noteTerminalQueryResponderKeyboard
} from '../../runtime/terminal-query-responder-election'

function install(): [string, boolean][] {
  const sent: [string, boolean][] = []
  installRendererQueryResponder((id, answers) => sent.push([id, answers]))
  return sent
}

describe('the desktop window in the query-responder election', () => {
  afterEach(() => {
    _resetRendererQueryResponderForTest()
    _resetTerminalQueryResponderElectionForTest()
  })

  it('answers alone, and stays quiet once a stream attaches until the user types in it', () => {
    const sent = install()
    setRendererQueryResponderVisible('pty', true)
    expect(sent).toEqual([])
    const releaseStream = attachTerminalQueryResponderCandidate('pty', 'native', 'stream', 'pod')
    expect(sent).toEqual([['pty', false]])
    // Its own replies are not the user.
    noteRendererPtyInput('pty', '\x1b[?62;22c')
    expect(sent).toEqual([['pty', false]])
    noteRendererPtyInput('pty', 'ls\r')
    expect(sent).toEqual([
      ['pty', false],
      ['pty', true]
    ])
    noteTerminalQueryResponderKeyboard('pty', 'native')
    expect(sent.at(-1)).toEqual(['pty', false])
    releaseStream()
    expect(sent.at(-1)).toEqual(['pty', true])
  })

  it('takes the answers back on a viewport claim and resets when the window hides the PTY', () => {
    const sent = install()
    setRendererQueryResponderVisible('pty', true)
    attachTerminalQueryResponderCandidate('pty', 'native', 'stream', 'pod')
    noteRendererViewportClaim('pty')
    expect(sent.at(-1)).toEqual(['pty', true])
    noteTerminalQueryResponderKeyboard('pty', 'native')
    expect(sent.at(-1)).toEqual(['pty', false])
    setRendererQueryResponderVisible('pty', false)
    expect(sent.at(-1)).toEqual(['pty', true])
  })

  it('ranks a passive phone below the window', () => {
    const sent = install()
    setRendererQueryResponderVisible('pty', true)
    attachTerminalQueryResponderCandidate('pty', 'phone', 'stream', 'phone', true)
    expect(sent).toEqual([])
  })
})
