// Fork-only (Pod): the opt-in that lets sandboxed agents use this Mac's Claude Code login.
import React from 'react'
import { SettingsSwitchRow } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function PodOrbstackClaudeLoginRow(props: {
  enabled: boolean
  busy: boolean
  onChange: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div data-testid="pod-orbstack-claude-login">
      <SettingsSwitchRow
        label={translate(
          'podOrbstack.claudeLogin.label',
          "Let sandboxed agents use this Mac's Claude Code login (the token stays on the Mac; same subscription limits)"
        )}
        description={translate(
          'podOrbstack.claudeLogin.description',
          'Off by default. When on, Claude Code in a sandbox sends its API calls through Pod on this Mac, which adds the login.'
        )}
        checked={props.enabled}
        disabled={props.busy}
        onChange={() => props.onChange(!props.enabled)}
      />
    </div>
  )
}
