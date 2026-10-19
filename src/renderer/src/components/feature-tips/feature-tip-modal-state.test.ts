import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getFeatureTipForModal } from './feature-tip-modal-state'

// Session search defaults on so tests about the older tips don't see the session-search tip first.
function makeSettings(sessionSearchEnabled = true): Pick<GlobalSettings, 'aiVaultSearch'> {
  return {
    aiVaultSearch: { enabled: sessionSearchEnabled, historyDays: null }
  }
}

describe('feature tip modal state', () => {
  it('keeps rendering the opened tip after app open has marked it seen', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: { tipId: 'cmd-j-palette' },
      seenTipIds: ['cmd-j-palette'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('cmd-j-palette')
  })

  it('falls back to the CLI tip first when no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: [],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the CLI tip when the palette tip was already seen and the CLI is not installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['cmd-j-palette'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the command palette tip after the CLI tip is handled', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['orca-cli'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('cmd-j-palette')
  })

  it('returns no tip when every tip is already seen and no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['orca-cli', 'cmd-j-palette'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })

  it('returns no CLI tip when the CLI is already installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['cmd-j-palette'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })

  it('refuses the native chat upgrade tip by id for any profile outside its audience', () => {
    for (const inNativeChatUpgradeTipAudience of [false, null]) {
      expect(
        getFeatureTipForModal({
          cliInstalled: true,
          modalData: { tipId: 'native-chat-upgrade' },
          seenTipIds: [],
          inNativeChatUpgradeTipAudience,
          featureInteractions: {},
          settings: makeSettings(),
          webClient: false
        })
      ).toBeNull()
    }
  })

  it('renders the native chat upgrade tip by id for its audience', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: { tipId: 'native-chat-upgrade' },
      seenTipIds: ['native-chat-upgrade'],
      inNativeChatUpgradeTipAudience: true,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('native-chat-upgrade')
  })

  it('never falls back to the native chat upgrade tip outside its audience', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['cmd-j-palette'],
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })
})
