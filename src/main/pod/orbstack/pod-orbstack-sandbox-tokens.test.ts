import { describe, expect, it } from 'vitest'
import { createSandboxHookTokens, createSandboxTokens } from './pod-orbstack-sandbox-tokens'

describe('sandbox tokens', () => {
  it('mints 32 random bytes per scope and revokes by token or scope', () => {
    const tokens = createSandboxTokens()
    const a = tokens.mint({ kind: 'orbstack-sandbox-hook', machine: 'pod-a-sbx' })
    const b = tokens.mint({ kind: 'orbstack-sandbox-hook', machine: 'pod-b-sbx' })
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(tokens.resolve(a)?.machine).toBe('pod-a-sbx')
    expect(tokens.resolve('')).toBeNull()
    tokens.revoke(a)
    expect(tokens.resolve(a)).toBeNull()
    tokens.revokeScope((scope) => scope.machine === 'pod-b-sbx')
    expect(tokens.resolve(b)).toBeNull()
  })

  it('keeps one hook token per sandbox until the sandbox goes', () => {
    const hooks = createSandboxHookTokens()
    const token = hooks.tokenFor('pod-a-sbx')
    expect(hooks.tokenFor('pod-a-sbx')).toBe(token)
    expect(hooks.authorizes('pod-a-sbx', token)).toBe(true)
    expect(hooks.authorizes('pod-b-sbx', token)).toBe(false)
    hooks.revokeMachine('pod-a-sbx')
    expect(hooks.authorizes('pod-a-sbx', token)).toBe(false)
    expect(hooks.tokenFor('pod-a-sbx')).not.toBe(token)
  })
})
