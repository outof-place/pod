// Fork-only (Pod): settings:set's write path, kept for podSettings.set.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { podDropClaudeHostSelection } from '../../claude-accounts/pod-claude-host-selection'

type SettingsWrite = (
  args: Partial<GlobalSettings>,
  originWebContentsId?: number
) => Promise<GlobalSettings>

export type PodSettingsWriter = (args: Partial<GlobalSettings>) => Promise<GlobalSettings>

let writer: PodSettingsWriter | null = null

/** settings:set's listener, keeping its write path for podSettings.set. */
export function podSettingsWritePath(
  write: SettingsWrite
): (event: { sender: { id: number } }, args: Partial<GlobalSettings>) => Promise<GlobalSettings> {
  // claude-acc owns Claude accounts: no client stores a host selection that halts its switching.
  writer = (args) => write(podDropClaudeHostSelection(args))
  return (event, args) => write(podDropClaudeHostSelection(args), event.sender.id)
}

export function getPodSettingsWriter(): PodSettingsWriter | null {
  return writer
}
