// Fork-only (Pod): podSettings.* — the settings a native Pod client renders from one schema.
import { defineMethod, defineStreamingMethod } from '../../runtime/rpc/core'
import {
  PodSettingsSetParams,
  PodSettingsUnsubscribeParams
} from '../../../shared/rpc-contract/pod-settings-params'
import { getPodSettingsService, type PodSettingsService } from './pod-settings-service'

function service(): PodSettingsService {
  const value = getPodSettingsService()
  if (!value) {
    throw new Error('Pod settings are off in this build.')
  }
  return value
}

let subscriptionSeq = 0
const subscriptionPrefix = (connectionId: string | undefined): string =>
  `pod-settings-${connectionId ?? 'inproc'}-`

// Why host-admin: these are the host's own preferences (its shell, hooks, folders), beyond the
// worktrees a workspace client manages.
export const POD_SETTINGS_METHODS = [
  defineMethod({
    name: 'podSettings.schema',
    permission: 'host-admin',
    params: null,
    handler: () => service().schema()
  }),
  defineMethod({
    name: 'podSettings.get',
    permission: 'host-admin',
    params: null,
    handler: () => service().get()
  }),
  defineMethod({
    name: 'podSettings.set',
    permission: 'host-admin',
    params: PodSettingsSetParams,
    handler: (params) => service().set(params.values, params.baseRevision)
  }),
  // Why a stream of its own: the snapshot comes first, then only changed fields, coalesced; a read
  // that fails is an `error` frame, and the stream goes on.
  defineStreamingMethod({
    name: 'podSettings.subscribe',
    permission: 'host-admin',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      const settings = service()
      await new Promise<void>((resolve) => {
        const { snapshot, unsubscribe } = settings.subscribe(
          (change) => emit({ type: 'changed', ...change }),
          (message) => emit({ type: 'error', message })
        )
        const subscriptionId = `${subscriptionPrefix(connectionId)}${++subscriptionSeq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId, ...snapshot })
      })
    }
  }),
  defineMethod({
    name: 'podSettings.unsubscribe',
    permission: 'host-admin',
    params: PodSettingsUnsubscribeParams,
    handler: (params, { runtime, connectionId }) => {
      if (!params.subscriptionId.startsWith(subscriptionPrefix(connectionId))) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
