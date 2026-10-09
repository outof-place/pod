import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPostCreateHygiene } from './workspace-post-create'

function fakeWatcher() {
  const watchers = new Map<string, (name: string | null) => void>()
  const closed: string[] = []
  const watchDirectory = (path: string, onName: (name: string | null) => void) => {
    watchers.set(path, onName)
    return {
      close: () => {
        closed.push(path)
      }
    }
  }
  return { watchers, closed, watchDirectory }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPostCreateHygiene', () => {
  it('excludes at once, then again once build dirs settle', async () => {
    const exclude = vi.fn(async () => undefined)
    const fake = fakeWatcher()
    const hygiene = createPostCreateHygiene({ exclude, watchDirectory: fake.watchDirectory })

    hygiene.checkoutCreated('/pod/acme/a.worktrees/x')
    expect(exclude).toHaveBeenCalledTimes(1)

    const notify = fake.watchers.get('/pod/acme/a.worktrees/x')
    notify?.('src')
    notify?.('node_modules')
    notify?.('node_modules')
    await vi.advanceTimersByTimeAsync(19_000)
    expect(exclude).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(exclude).toHaveBeenCalledTimes(2)
    hygiene.dispose()
  })

  it('runs a final pass when the watch window ends', async () => {
    const exclude = vi.fn(async () => undefined)
    const fake = fakeWatcher()
    const hygiene = createPostCreateHygiene({ exclude, watchDirectory: fake.watchDirectory })
    hygiene.checkoutCreated('/pod/a')
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(exclude).toHaveBeenCalledTimes(2)
    expect(fake.closed).toEqual(['/pod/a'])
  })

  it('stops watching a removed checkout without another pass', async () => {
    const exclude = vi.fn(async () => undefined)
    const fake = fakeWatcher()
    const hygiene = createPostCreateHygiene({ exclude, watchDirectory: fake.watchDirectory })
    hygiene.checkoutCreated('/pod/a')
    hygiene.checkoutRemoved('/pod/a')
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(exclude).toHaveBeenCalledTimes(1)
    expect(fake.closed).toEqual(['/pod/a'])
  })
})
