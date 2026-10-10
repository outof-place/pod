import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import {
  localCloneAdded,
  localCloneOptions,
  setLocalCloneAddedListener,
  setLocalCloneOptionsOverride
} from './repo-clone-options'

const repo: Repo = {
  id: 'r',
  path: '/p/acme/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git'
}

afterEach(() => {
  setLocalCloneOptionsOverride(null)
  setLocalCloneAddedListener(null)
})

describe('local clone seams', () => {
  it('add nothing without a downstream override', async () => {
    await expect(localCloneOptions('/p/acme/app')).resolves.toEqual([])
    await expect(localCloneAdded(repo)).resolves.toBeUndefined()
  })

  it('wait for the listener and never fail the clone', async () => {
    const seen: string[] = []
    setLocalCloneAddedListener(async (added) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(added.id)
    })
    await localCloneAdded(repo)
    expect(seen).toEqual(['r'])
    setLocalCloneAddedListener(async () => {
      throw new Error('boom')
    })
    setLocalCloneOptionsOverride(async () => {
      throw new Error('boom')
    })
    await expect(localCloneAdded(repo)).resolves.toBeUndefined()
    await expect(localCloneOptions('/p/acme/app')).resolves.toEqual([])
  })
})
