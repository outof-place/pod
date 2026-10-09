import { describe, expect, it } from 'vitest'
import {
  formatProductUiIdentityArgument,
  readProductUiIdentityArgument,
  type ProductUiIdentity
} from './product-ui-identity'
import { isStablyHostedUrl } from './stably-hosted-url'

const pod: ProductUiIdentity = {
  displayName: 'Pod',
  cliName: 'podx',
  stablyServices: false,
  repositoryUrl: 'https://github.com/outof-place/pod'
}

describe('product UI identity argument', () => {
  it('round-trips through argv and is absent for upstream renderers', () => {
    const argv = ['/Applications/Pod.app', formatProductUiIdentityArgument(pod), '--other']
    expect(readProductUiIdentityArgument(argv)).toEqual(pod)
    expect(readProductUiIdentityArgument(['/Applications/Orca.app'])).toBeNull()
  })

  it('rejects a malformed stamp instead of guessing', () => {
    expect(readProductUiIdentityArgument(['--orca-product-ui-identity=%7B'])).toBeNull()
    const wrongType = `--orca-product-ui-identity=${encodeURIComponent(
      JSON.stringify({ ...pod, stablyServices: 'no' })
    )}`
    expect(readProductUiIdentityArgument([wrongType])).toBeNull()
  })
})

describe('isStablyHostedUrl', () => {
  it('matches Stably hosts and their subdomains only', () => {
    expect(isStablyHostedUrl('https://www.onorca.dev/docs/terminal')).toBe(true)
    expect(isStablyHostedUrl('https://app.orca.dev/skills/share/x')).toBe(true)
    expect(isStablyHostedUrl('https://github.com/stablyai/orca')).toBe(false)
    expect(isStablyHostedUrl('https://notonorca.dev')).toBe(false)
    expect(isStablyHostedUrl('not a url')).toBe(false)
  })
})
