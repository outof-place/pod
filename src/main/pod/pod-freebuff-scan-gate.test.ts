import { describe, expect, it } from 'vitest'
import { podScansForFreebuff } from './pod-freebuff-scan-gate'

describe('podScansForFreebuff', () => {
  it('scans while the pane names no agent, Freebuff included', () => {
    expect(podScansForFreebuff('plain output\r\n', null)).toBe(true)
    expect(podScansForFreebuff('plain output\r\n', '')).toBe(true)
    expect(podScansForFreebuff('plain output\r\n', 'zsh')).toBe(true)
    expect(podScansForFreebuff('\x1b[?2026l', 'Freebuff: fix the bug')).toBe(true)
  })

  it('skips under another agent title', () => {
    expect(podScansForFreebuff('\x1b[?2026h frame \x1b[?2026l', '✳ Claude Code')).toBe(false)
    expect(podScansForFreebuff('frame', 'Codex')).toBe(false)
  })

  it('reads a title the chunk itself sets first', () => {
    expect(podScansForFreebuff('\x1b]0;Freebuff: go\x07frame', '✳ Claude Code')).toBe(true)
    expect(podScansForFreebuff('\x1b]0;✳ Claude Code\x07frame', null)).toBe(false)
    expect(podScansForFreebuff('\x1b]0;\x07$ ', '✳ Claude Code')).toBe(true)
  })
})
