import { describe, expect, it } from 'vitest'
import { podHeadlessQueryReply } from './pod-headless-query-reply-policy'

describe('podHeadlessQueryReply', () => {
  const xtVersion = '\x1bP>|xterm.js(6.0.0)\x1b\\'
  const pod = '\x1bP>|Pod\x1b\\'
  const shell = { launchAgent: null, title: null }

  it('names the model Pod to a Claude Code launch', () => {
    expect(podHeadlessQueryReply({ launchAgent: 'claude', title: null }, xtVersion)).toBe(pod)
  })

  it('names the model Pod to a hand-typed Claude Code by its title', () => {
    for (const title of ['✳ Claude Code', 'Claude Code', '⠂ Claude Code']) {
      expect(podHeadlessQueryReply({ launchAgent: null, title }, xtVersion)).toBe(pod)
    }
  })

  it('keeps XTVERSION for other terminals and a cleared title', () => {
    expect(podHeadlessQueryReply(shell, xtVersion)).toBe(xtVersion)
    expect(podHeadlessQueryReply({ launchAgent: 'codex', title: null }, xtVersion)).toBe(xtVersion)
    for (const title of ['', 'VIM - notes.md', 'nvim', 'htop', 'less README.md', 'zsh']) {
      expect(podHeadlessQueryReply({ launchAgent: null, title }, xtVersion)).toBe(xtVersion)
    }
  })

  it('keeps every other Claude reply', () => {
    const claude = { launchAgent: 'claude' as const, title: '✳ Claude Code' }
    for (const reply of [
      '\x1b[?1;2c',
      '\x1b[?0u',
      '\x1b[?2026;2$y',
      '\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\'
    ]) {
      expect(podHeadlessQueryReply(claude, reply)).toBe(reply)
    }
  })
})
