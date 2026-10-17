import { describe, expect, it } from 'vitest'
import { readMacClaudeChoices } from './pod-orbstack-mac-claude-choices'

describe('readMacClaudeChoices', () => {
  const reading = (files: Record<string, string>) => (path: string) => {
    const text = files[path]
    if (text === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return text
  }

  it('reads only the theme and the accepted bypass warning from the user settings', () => {
    const read = reading({
      '/h/.claude/settings.json': JSON.stringify({
        theme: 'light-daltonized',
        skipDangerousModePermissionPrompt: true,
        apiKeyHelper: '/bin/key',
        env: { ANTHROPIC_API_KEY: 'x' }
      })
    })
    expect(readMacClaudeChoices({}, '/h', read)).toEqual({
      theme: 'light-daltonized',
      skipDangerousModePermissionPrompt: true
    })
  })

  it('turns a custom theme into the preset it is based on, and never copies its file', () => {
    const read = reading({
      '/h/.claude/settings.json': JSON.stringify({ theme: 'custom:portivo' }),
      '/h/.claude/themes/portivo.json': JSON.stringify({ name: 'Portivo', base: 'light' })
    })
    expect(readMacClaudeChoices({}, '/h', read).theme).toBe('light')
    const missing = reading({
      '/h/.claude/settings.json': JSON.stringify({ theme: 'custom:gone' })
    })
    expect(readMacClaudeChoices({}, '/h', missing).theme).toBeNull()
  })

  it('follows CLAUDE_CONFIG_DIR and falls back to the legacy ~/.claude.json theme', () => {
    const read = reading({ '/acct/.claude.json': JSON.stringify({ theme: 'dark-ansi' }) })
    expect(readMacClaudeChoices({ CLAUDE_CONFIG_DIR: '/acct' }, '/h', read)).toEqual({
      theme: 'dark-ansi',
      skipDangerousModePermissionPrompt: false
    })
  })

  it('gives nothing for missing files, bad JSON or odd values', () => {
    expect(readMacClaudeChoices({}, '/h', reading({}))).toEqual({
      theme: null,
      skipDangerousModePermissionPrompt: false
    })
    expect(
      readMacClaudeChoices({}, '/h', reading({ '/h/.claude/settings.json': '{' })).theme
    ).toBeNull()
    for (const theme of [42, 'Dark', 'dark;rm', 'x'.repeat(40), '', 'custom:../x']) {
      const read = reading({
        '/h/.claude/settings.json': JSON.stringify({
          theme,
          skipDangerousModePermissionPrompt: 'yes'
        })
      })
      expect(readMacClaudeChoices({}, '/h', read), String(theme)).toEqual({
        theme: null,
        skipDangerousModePermissionPrompt: false
      })
    }
  })
})
