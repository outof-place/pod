import { describe, expect, it, vi } from 'vitest'
import { workItemCreateSetupTrust } from './create-setup-trust'

describe('a direct launch’s setup trust (Pod)', () => {
  it('counts a pull or merge request’s head as someone else’s code, an issue’s base not', () => {
    const onTrusted = vi.fn()
    expect(workItemCreateSetupTrust('pr', 'abc', onTrusted)).toEqual({
      baseRef: 'abc',
      foreign: true,
      onTrusted
    })
    expect(workItemCreateSetupTrust('mr', undefined, onTrusted).foreign).toBe(true)
    expect(workItemCreateSetupTrust('issue', undefined, onTrusted).foreign).toBe(false)
  })
})
