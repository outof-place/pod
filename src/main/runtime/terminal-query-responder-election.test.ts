import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetTerminalQueryResponderElectionForTest,
  attachTerminalQueryResponderCandidate,
  isTerminalQueryResponder,
  noteTerminalQueryResponderClaim,
  noteTerminalQueryResponderKeyboard,
  terminalQueryResponder
} from './terminal-query-responder-election'

describe('terminal query responder election', () => {
  afterEach(() => _resetTerminalQueryResponderElectionForTest())

  it('has no responder without views, so main answers', () => {
    expect(terminalQueryResponder('pty')).toBeNull()
  })

  it('prefers the keyboard, then the last claim, then the oldest stream, then a renderer', () => {
    attachTerminalQueryResponderCandidate('pty', 'renderer', 'renderer')
    expect(isTerminalQueryResponder('pty', 'renderer')).toBe(true)
    attachTerminalQueryResponderCandidate('pty', 'a', 'stream', 'client-a')
    attachTerminalQueryResponderCandidate('pty', 'b', 'stream', 'client-b')
    expect(isTerminalQueryResponder('pty', 'a')).toBe(true)
    noteTerminalQueryResponderClaim('pty', 'b')
    expect(isTerminalQueryResponder('pty', 'b')).toBe(true)
    noteTerminalQueryResponderKeyboard('pty', 'renderer')
    expect(isTerminalQueryResponder('pty', 'renderer')).toBe(true)
    noteTerminalQueryResponderClaim('pty', 'a')
    expect(isTerminalQueryResponder('pty', 'renderer')).toBe(true)
    noteTerminalQueryResponderKeyboard('pty', 'a')
    expect(terminalQueryResponder('pty')).toMatchObject({ key: 'a', clientId: 'client-a' })
  })

  it('falls back when the responder leaves, and ignores a second release', () => {
    const releaseA = attachTerminalQueryResponderCandidate('pty', 'a', 'stream')
    attachTerminalQueryResponderCandidate('pty', 'b', 'stream')
    noteTerminalQueryResponderKeyboard('pty', 'a')
    releaseA()
    expect(isTerminalQueryResponder('pty', 'b')).toBe(true)
    releaseA()
    expect(isTerminalQueryResponder('pty', 'b')).toBe(true)
  })

  it('keeps PTYs apart', () => {
    attachTerminalQueryResponderCandidate('one', 'a', 'stream')
    attachTerminalQueryResponderCandidate('two', 'b', 'stream')
    expect(isTerminalQueryResponder('one', 'b')).toBe(false)
    expect(isTerminalQueryResponder('two', 'b')).toBe(true)
  })
})
