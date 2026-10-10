import { describe, expect, it } from 'vitest'
import { createPodCloneOptions } from './workspace-clone-options'

const facts = (version: [number, number, number] | null) => async () => ({
  version,
  geometric: true,
  backfill: true,
  refsMigrate: true
})

describe('createPodCloneOptions', () => {
  it('starts new clones into the Pod root on reftable', async () => {
    const options = createPodCloneOptions({
      isEnabled: () => true,
      root: () => '/Users/me/pod',
      hostFacts: facts([2, 56, 0])
    })
    await expect(options('/Users/me/pod/acme/app')).resolves.toEqual(['--ref-format=reftable'])
    await expect(options('/Users/me/elsewhere/app')).resolves.toEqual([])
  })

  it('adds nothing with the workspace off or a git older than 2.45', async () => {
    const off = createPodCloneOptions({
      isEnabled: () => false,
      root: () => '/Users/me/pod',
      hostFacts: facts([2, 56, 0])
    })
    const old = createPodCloneOptions({
      isEnabled: () => true,
      root: () => '/Users/me/pod',
      hostFacts: facts([2, 44, 9])
    })
    await expect(off('/Users/me/pod/acme/app')).resolves.toEqual([])
    await expect(old('/Users/me/pod/acme/app')).resolves.toEqual([])
  })
})
