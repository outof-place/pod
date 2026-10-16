import { describe, expect, it, vi } from 'vitest'
import type {
  PodSshCredentialEvent,
  PodSshCredentialRequest
} from '../../../shared/pod-ssh-credential-event'
import { PodSshCredentialHub } from './pod-ssh-credential-hub'

const request = (requestId: string): PodSshCredentialRequest => ({
  requestId,
  targetId: 'ssh-1',
  kind: 'passphrase',
  detail: '~/.ssh/id_ed25519',
  expiresAtMs: 1_000
})

describe('PodSshCredentialHub', () => {
  it('tells the asker whether anyone listens', () => {
    const hub = new PodSshCredentialHub()
    expect(hub.ask(request('a'), vi.fn())).toBe(false)
    const stop = hub.subscribe(vi.fn())
    expect(hub.ask(request('b'), vi.fn())).toBe(true)
    stop()
    expect(hub.ask(request('c'), vi.fn())).toBe(false)
  })

  it('replays the open prompts to a late subscriber, then streams the rest', () => {
    const hub = new PodSshCredentialHub()
    hub.ask(request('a'), vi.fn())
    hub.ask(request('b'), vi.fn())
    hub.settle('a', 'submitted')
    const events: PodSshCredentialEvent[] = []

    hub.subscribe((event) => events.push(event))
    hub.ask(request('c'), vi.fn())
    hub.settle('b', 'timeout')
    hub.settle('b', 'cancelled')

    expect(events).toEqual([
      { type: 'sshCredentialRequested', ...request('b') },
      { type: 'sshCredentialRequested', ...request('c') },
      { type: 'sshCredentialResolved', requestId: 'b', reason: 'timeout' }
    ])
  })

  it('hands an answer to the open prompt only', () => {
    const hub = new PodSshCredentialHub()
    const answer = vi.fn()
    hub.ask(request('a'), answer)

    expect(hub.submit('a', 'secret')).toBe(true)
    expect(hub.submit('nope', 'secret')).toBe(false)
    hub.settle('a', 'submitted')
    expect(hub.submit('a', 'late')).toBe(false)
    expect(answer.mock.calls).toEqual([['secret']])
  })

  it('keeps streaming to the other listeners when one throws', () => {
    const hub = new PodSshCredentialHub()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen = vi.fn()
    hub.subscribe(() => {
      throw new Error('gone')
    })
    hub.subscribe(seen)

    hub.ask(request('a'), vi.fn())

    expect(seen).toHaveBeenCalledWith({ type: 'sshCredentialRequested', ...request('a') })
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
