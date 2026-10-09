import { watch } from 'node:fs'

// Setup (orca.yaml, pnpm install) runs in a terminal with no completion signal in main, so watch
// the new checkout's top level for a while and exclude build dirs once they appear.
const WATCH_LIFETIME_MS = 15 * 60 * 1000
const SETTLE_MS = 20_000
const MAX_WATCHED_CHECKOUTS = 8
const BUILD_DIR_TRIGGERS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.pnpm-store',
  'DerivedData',
  'target',
  '.build'
])

type ClosableWatcher = { close(): void }

export type PostCreateHygieneDeps = {
  exclude: (checkoutPath: string) => Promise<void>
  watchDirectory?: (path: string, onName: (name: string | null) => void) => ClosableWatcher | null
}

type WatchedCheckout = {
  watcher: ClosableWatcher | null
  settle: NodeJS.Timeout | null
  end: NodeJS.Timeout
}

function watchTopLevel(
  path: string,
  onName: (name: string | null) => void
): ClosableWatcher | null {
  try {
    const watcher = watch(path, { persistent: false }, (_event, name) => onName(name))
    watcher.on('error', () => watcher.close())
    return watcher
  } catch {
    return null
  }
}

export function createPostCreateHygiene(deps: PostCreateHygieneDeps) {
  const watched = new Map<string, WatchedCheckout>()

  const run = (path: string): void => {
    void deps.exclude(path).catch((error) => {
      console.warn('[pod-workspace] post-create exclusion failed:', error)
    })
  }

  const stop = (path: string, finalPass: boolean): void => {
    const entry = watched.get(path)
    if (!entry) {
      return
    }
    watched.delete(path)
    entry.watcher?.close()
    if (entry.settle) {
      clearTimeout(entry.settle)
    }
    clearTimeout(entry.end)
    if (finalPass) {
      run(path)
    }
  }

  return {
    checkoutCreated(path: string): void {
      if (watched.has(path)) {
        return
      }
      // A copied or cloned checkout can arrive with its build dirs already in place.
      run(path)
      if (watched.size >= MAX_WATCHED_CHECKOUTS) {
        return
      }
      const entry: WatchedCheckout = {
        watcher: null,
        settle: null,
        end: setTimeout(() => stop(path, true), WATCH_LIFETIME_MS)
      }
      entry.end.unref?.()
      entry.watcher = (deps.watchDirectory ?? watchTopLevel)(path, (name) => {
        if (name !== null && !BUILD_DIR_TRIGGERS.has(name)) {
          return
        }
        // Why settle: package managers keep writing nested node_modules after the top one exists.
        if (entry.settle) {
          clearTimeout(entry.settle)
        }
        entry.settle = setTimeout(() => {
          entry.settle = null
          run(path)
        }, SETTLE_MS)
        entry.settle.unref?.()
      })
      watched.set(path, entry)
    },

    checkoutRemoved(path: string): void {
      stop(path, false)
    },

    dispose(): void {
      // Deleting the visited key while iterating a Map is safe.
      for (const path of watched.keys()) {
        stop(path, false)
      }
    }
  }
}

export type PostCreateHygiene = ReturnType<typeof createPostCreateHygiene>
