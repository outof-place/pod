import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { realpathMock } = vi.hoisted(() => ({ realpathMock: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  realpath: realpathMock
}))

import {
  readRepoCheckoutRealPath,
  readRepoCheckoutRealPaths,
  REPO_CHECKOUT_REAL_PATH_TIMEOUT_MS
} from './repo-checkout-real-path'

describe('repo checkout real paths on a stalled mount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    realpathMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a stalled read after the bound and never starts a second one beside it', async () => {
    let finish: (path: string) => void = () => {}
    realpathMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const repo = { path: '/Volumes/nas/app' }

    const first = readRepoCheckoutRealPaths([repo])
    await vi.advanceTimersByTimeAsync(REPO_CHECKOUT_REAL_PATH_TIMEOUT_MS)
    expect((await first).size).toBe(0)
    const second = readRepoCheckoutRealPath(repo)
    await vi.advanceTimersByTimeAsync(REPO_CHECKOUT_REAL_PATH_TIMEOUT_MS)
    expect(await second).toBeUndefined()
    expect(realpathMock).toHaveBeenCalledTimes(1)

    finish('/Volumes/nas-real/app')
    await vi.advanceTimersByTimeAsync(0)
    realpathMock.mockResolvedValueOnce('/Volumes/nas-real/app')
    expect(await readRepoCheckoutRealPath(repo)).toBe('/Volumes/nas-real/app')
    expect(realpathMock).toHaveBeenCalledTimes(2)
  })

  it('makes no filesystem call for a repo on another host', async () => {
    expect(await readRepoCheckoutRealPath({ path: '/srv/app', connectionId: 'build-box' })).toBe(
      undefined
    )
    expect(
      (await readRepoCheckoutRealPaths([{ path: '/srv/app', connectionId: 'box' }])).size
    ).toBe(0)
    expect(realpathMock).not.toHaveBeenCalled()
  })
})
