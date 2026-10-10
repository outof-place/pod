import { stat } from 'node:fs/promises'
import { subscribeViaWatcherProcess } from '../ipc/parcel-watcher-process'
import {
  resolveWatcherRootPaths,
  rewriteWatcherEvents
} from '../ipc/watcher-event-root-path-rewrite'
import type { SessionTreeWatchSubscribe } from './session-scanner-service-tree-watch'

export const subscribeSessionTree: SessionTreeWatchSubscribe = async (root, callback, hooks) => {
  // Bind the identity and watcher to one target even if the alias changes while subscribing.
  const { watchRoot, rewriteEventPath } = resolveWatcherRootPaths(root)
  const { dev, ino } = await stat(watchRoot)
  const subscription = await subscribeViaWatcherProcess(
    watchRoot,
    (error, events) => callback(error, rewriteWatcherEvents(events, rewriteEventPath)),
    {},
    hooks
  )
  return { ...subscription, identity: { dev, ino } }
}
