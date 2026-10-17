import { describe, expect, it } from 'vitest'
import { carriesSandboxPlaceholder } from './pod-orbstack-sandbox-placeholder'

describe('carriesSandboxPlaceholder', () => {
  const placeholder = 'pod-sandbox-no-credential-0123456789abcdef0123456789abcdef'

  it('takes the placeholder as an API key or a bearer, by header name in any case', () => {
    expect(carriesSandboxPlaceholder(['x-api-key', placeholder], placeholder)).toBe(true)
    expect(carriesSandboxPlaceholder(['Authorization', `Bearer ${placeholder}`], placeholder)).toBe(
      true
    )
    expect(
      carriesSandboxPlaceholder(['accept', '*/*', 'X-Api-Key', placeholder], placeholder)
    ).toBe(true)
  })

  it('refuses anything else, and everything while the sandbox has none', () => {
    expect(carriesSandboxPlaceholder([], placeholder)).toBe(false)
    expect(carriesSandboxPlaceholder(['x-api-key', `${placeholder}x`], placeholder)).toBe(false)
    expect(carriesSandboxPlaceholder(['authorization', placeholder], placeholder)).toBe(false)
    expect(carriesSandboxPlaceholder(['cookie', placeholder], placeholder)).toBe(false)
    expect(carriesSandboxPlaceholder(['x-api-key', placeholder], null)).toBe(false)
    expect(carriesSandboxPlaceholder(['x-api-key', ''], '')).toBe(false)
  })
})
