import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import type { WatcherProcessCallback } from '../ipc/parcel-watcher-process'

const mocks = vi.hoisted(() => ({ stat: vi.fn(), subscribe: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stat: mocks.stat
}))
vi.mock('../ipc/parcel-watcher-process', () => ({ subscribeViaWatcherProcess: mocks.subscribe }))

import { subscribeSessionTree } from './session-scanner-service-tree-subscribe'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-tree-subscription-'))
  mocks.stat.mockReset()
  mocks.subscribe.mockReset()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('pins subscription and identity to one target across an alias changing away and back', async () => {
  const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const first = join(root, 'first')
  const second = join(root, 'second')
  const alias = join(root, 'alias')
  await mkdir(first)
  await mkdir(second)
  await symlink(first, alias, 'junction')
  const canonicalFirst = await realpath(first)
  const identity = await fs.stat(first)
  mocks.stat.mockImplementationOnce(async (path: string) => {
    const result = await fs.stat(path)
    await rm(alias)
    await symlink(second, alias, 'junction')
    return result
  })
  let nativeCallback: WatcherProcessCallback = () => undefined
  const unsubscribe = vi.fn(async () => undefined)
  mocks.subscribe.mockImplementationOnce(
    async (_path: string, callback: WatcherProcessCallback) => {
      nativeCallback = callback
      await rm(alias)
      await symlink(first, alias, 'junction')
      return { unsubscribe }
    }
  )
  const callback = vi.fn()
  const subscription = await subscribeSessionTree(alias, callback, {})

  expect(mocks.stat).toHaveBeenCalledWith(canonicalFirst)
  expect(mocks.subscribe).toHaveBeenCalledWith(canonicalFirst, expect.any(Function), {}, {})
  expect(subscription.identity).toEqual({ dev: identity.dev, ino: identity.ino })
  nativeCallback(null, [{ type: 'create', path: join(canonicalFirst, 'later.jsonl') }])
  expect(callback).toHaveBeenCalledWith(null, [
    { type: 'create', path: join(alias, 'later.jsonl') }
  ])
  await subscription.unsubscribe()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
