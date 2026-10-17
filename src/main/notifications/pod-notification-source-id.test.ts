import { describe, expect, it, vi } from 'vitest'
import { createNotificationDeliveryService } from './notification-delivery-service'
import type { NotificationDeliveryDependencies } from './notification-delivery-service'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'

function setup(mutedNotificationSourceIds: NotificationSettings['mutedNotificationSourceIds']) {
  const settings: NotificationSettings = {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 1,
    mutedNotificationSourceIds
  }
  const dispatchMobileNotification = vi.fn()
  const deps: NotificationDeliveryDependencies = {
    readNotificationSettings: () => settings,
    findActiveWindow: () => null,
    isWindowVisible: () => false,
    setTrayAttention: vi.fn(),
    isNotificationSupported: () => true,
    dispatchMobileNotification,
    readAuthorizationStatus: () => Promise.resolve('authorized'),
    recordDeliveryOutcome: vi.fn(),
    deliverNative: vi.fn(() => ({ delivered: true }) as const),
    platform: 'linux',
    // Past the 5 s burst window the first alert of a fresh service is measured against.
    now: () => 100_000
  }
  return { service: createNotificationDeliveryService(deps), dispatchMobileNotification }
}

function request(
  overrides: Partial<NotificationDispatchRequest> = {}
): NotificationDispatchRequest {
  return { source: 'agent-task-complete', worktreeId: 'wt-1', worktreeLabel: 'wt-1', ...overrides }
}

describe('notificationSourceId on streamed alerts (Pod)', () => {
  it('names the machine an alert came through', () => {
    const { service, dispatchMobileNotification } = setup([])
    service.dispatch(request({ notificationSourceId: 'ssh:box' }))
    expect(dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notificationSourceId: 'ssh:box' })
    )
  })

  it('still streams a muted machine, for the phone and for clients that apply mutes themselves', () => {
    const { service, dispatchMobileNotification } = setup(['ssh:box'])
    expect(service.dispatch(request({ notificationSourceId: 'ssh:box' }))).toEqual({
      delivered: false,
      reason: 'host-muted'
    })
    expect(dispatchMobileNotification).toHaveBeenCalledWith(
      expect.objectContaining({ notificationSourceId: 'ssh:box' })
    )
  })

  it('leaves the field out when the alert names no machine', () => {
    const { service, dispatchMobileNotification } = setup([])
    service.dispatch(request())
    expect(dispatchMobileNotification.mock.calls[0]?.[0]).not.toHaveProperty('notificationSourceId')
  })
})
