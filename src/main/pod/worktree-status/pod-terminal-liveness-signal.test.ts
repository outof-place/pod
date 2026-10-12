// Fork-only (Pod): the runtime says when worktree.ps's live terminals may have moved.
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { subscribePodTerminalLiveness } from './pod-terminal-liveness-signal'

let stop: () => void = () => {}
afterEach(() => stop())

describe('the terminal liveness signal', () => {
  it('fires when a PTY registers and when it exits', () => {
    let fired = 0
    stop = subscribePodTerminalLiveness(() => {
      fired += 1
    })
    const runtime = new OrcaRuntimeService()
    runtime.registerPty('pty-1', 'repo::/w')
    expect(fired).toBe(1)
    runtime.onPtyExit('pty-1', 0)
    expect(fired).toBe(2)
  })

  it('keeps going past a listener that throws', () => {
    let fired = 0
    const stopThrowing = subscribePodTerminalLiveness(() => {
      throw new Error('boom')
    })
    stop = subscribePodTerminalLiveness(() => {
      fired += 1
    })
    try {
      new OrcaRuntimeService().registerPty('pty-2', 'repo::/w')
    } finally {
      stopThrowing()
    }
    expect(fired).toBe(1)
  })
})
