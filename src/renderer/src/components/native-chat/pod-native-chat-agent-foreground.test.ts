// Fork-only (Pod): native chat's agent text is written only while an agent holds the terminal. A
// refused send says why and sends nothing more; bare keys that answer the agent's UI stay unguarded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import {
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatAskAnswer,
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from './native-chat-runtime-send'
import { nativeChatAgentNotInForegroundNotice } from './native-chat-agent-foreground-notice'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'

const SETTINGS = null
const PTY = 'pty-1'
const GUARD = { requireAgentForeground: true }
const refusal = (reason: string) =>
  new Error(
    `Error invoking remote method 'pty:writeAccepted': Error: agent_not_in_foreground: ${reason}`
  )

beforeEach(() => {
  vi.useFakeTimers()
  sendRuntimePtyInput.mockReset()
  sendRuntimePtyInput.mockReturnValue(true)
  sendRuntimePtyInputVerified.mockReset()
  resetNativeChatPtySendQueuesForTests()
})
afterEach(() => {
  vi.useRealTimers()
  resetNativeChatPtySendQueuesForTests()
})

describe('a guarded chat message', () => {
  it('writes its body and its Enter as guarded writes', async () => {
    sendRuntimePtyInputVerified.mockResolvedValue(true)

    sendNativeChatMessage(SETTINGS, PTY, 'ship it', { requireAgentForeground: true })
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(sendRuntimePtyInputVerified.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      [buildNativeChatPasteBytes('ship it'), GUARD],
      [NATIVE_CHAT_SUBMIT, GUARD]
    ])
  })

  it('stops at a refused body, says why, and sends no Enter', async () => {
    sendRuntimePtyInputVerified.mockRejectedValue(refusal('shell'))
    const onAgentNotInForeground = vi.fn()
    const onWriteRejected = vi.fn()
    const onWriteUnconfirmed = vi.fn()

    sendNativeChatMessage(SETTINGS, PTY, 'ship it', {
      requireAgentForeground: true,
      onAgentNotInForeground,
      onWriteRejected,
      onWriteUnconfirmed
    })
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS * 2)

    expect(onAgentNotInForeground).toHaveBeenCalledExactlyOnceWith('shell')
    expect(onWriteRejected).not.toHaveBeenCalled()
    expect(onWriteUnconfirmed).not.toHaveBeenCalled()
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledOnce()
  })
})

describe('a guarded typed command', () => {
  it('reports a refused key', async () => {
    sendRuntimePtyInputVerified.mockRejectedValue(refusal('not_agent'))
    const onAgentNotInForeground = vi.fn()

    sendNativeChatTypedCommand(SETTINGS, PTY, '/status', onAgentNotInForeground)
    await vi.runAllTimersAsync()

    expect(onAgentNotInForeground).toHaveBeenCalledExactlyOnceWith('not_agent')
    expect(sendRuntimePtyInputVerified.mock.calls[0]?.[4]).toEqual(GUARD)
  })
})

describe('an answer to an agent’s question', () => {
  it('guards its text and an Enter, not its bare keys', async () => {
    sendRuntimePtyInputVerified.mockResolvedValue(true)

    sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '1' }, { raw: '2\r' }, { text: 'custom' }])
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_STEP_MS * 3)

    expect(sendRuntimePtyInputVerified.mock.calls.map((call) => [call[2], call[4]])).toEqual([
      ['1', undefined],
      ['2\r', GUARD],
      [buildNativeChatPasteBytes('custom'), GUARD]
    ])
  })
})

describe('the refusal notice', () => {
  it('says the message was not sent and names the reason', () => {
    expect(nativeChatAgentNotInForegroundNotice('shell')).toBe(
      "Not sent: the agent isn't in front in this terminal (shell)"
    )
  })
})
