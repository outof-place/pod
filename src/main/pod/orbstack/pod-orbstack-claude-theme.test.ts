import { describe, expect, it } from 'vitest'
import { readMacClaudeTheme } from './pod-orbstack-claude-theme'

describe('readMacClaudeTheme', () => {
  const reading = (files: Record<string, string>) => (path: string) => {
    const text = files[path]
    if (text === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return text
  }

  it('reads only the theme from the Mac config', () => {
    const read = reading({
      '/h/.claude.json': JSON.stringify({ theme: 'light-daltonized', oauthAccount: { x: 1 } })
    })
    expect(readMacClaudeTheme({}, '/h', read)).toBe('light-daltonized')
  })

  it('follows CLAUDE_CONFIG_DIR as Claude Code does', () => {
    const read = reading({ '/acct/.claude.json': JSON.stringify({ theme: 'dark-ansi' }) })
    expect(readMacClaudeTheme({ CLAUDE_CONFIG_DIR: '/acct' }, '/h', read)).toBe('dark-ansi')
  })

  it('gives null for a missing file, bad JSON or an odd value', () => {
    expect(readMacClaudeTheme({}, '/h', reading({}))).toBeNull()
    expect(readMacClaudeTheme({}, '/h', reading({ '/h/.claude.json': '{' }))).toBeNull()
    for (const theme of [42, 'Dark', 'dark;rm', 'x'.repeat(40), '']) {
      const read = reading({ '/h/.claude.json': JSON.stringify({ theme }) })
      expect(readMacClaudeTheme({}, '/h', read), String(theme)).toBeNull()
    }
  })
})
