import { translate } from '@/i18n/i18n'
import type {
  PodWorkspaceRootIssueCode,
  PodWorkspaceSpotlight,
  PodWorkspaceTimeMachineDestination
} from '../../../../shared/pod-workspace-types'

export function rootIssueMessage(code: PodWorkspaceRootIssueCode): string {
  switch (code) {
    case 'empty':
      return translate('podWorkspace.root.issue.empty', 'Enter a folder.')
    case 'not-absolute':
      return translate(
        'podWorkspace.root.issue.notAbsolute',
        'Use an absolute path or one that starts with ~/.'
      )
    case 'not-a-directory':
      return translate('podWorkspace.root.issue.notDirectory', 'This path is a file, not a folder.')
    case 'icloud-drive':
      return translate(
        'podWorkspace.root.issue.icloudDrive',
        'iCloud Drive syncs every file agents and installs write. Choose a folder outside it.'
      )
    case 'icloud-desktop-documents':
      return translate(
        'podWorkspace.root.issue.icloudDesktopDocuments',
        'iCloud syncs Desktop and Documents on this Mac. Choose a folder outside them.'
      )
    case 'icloud-desktop-documents-unknown':
      return translate(
        'podWorkspace.root.issue.icloudDesktopDocumentsUnknown',
        'Could not tell whether iCloud syncs Desktop and Documents. If it does, choose another folder.'
      )
    case 'documents-desktop-tcc':
      return translate(
        'podWorkspace.root.issue.documentsDesktopTcc',
        'Background jobs need a privacy permission to read Desktop and Documents.'
      )
  }
}

export function spotlightStateLabel(state: PodWorkspaceSpotlight['state']): string {
  switch (state) {
    case 'indexed':
      return translate('podWorkspace.spotlight.state.indexed', 'Indexed')
    case 'excluded':
      return translate('podWorkspace.spotlight.state.excluded', 'Excluded')
    case 'unknown':
      return translate('podWorkspace.spotlight.state.unknown', 'Unknown')
  }
}

export function spotlightDetail(spotlight: PodWorkspaceSpotlight, root: string): string {
  if (spotlight.state === 'indexed') {
    return translate(
      'podWorkspace.spotlight.detail.indexed',
      'Spotlight indexes this folder and re-reads files as agents and installs write them. To stop it, open System Settings › Spotlight › Search Privacy…, click +, and add {{root}}.',
      { root }
    )
  }
  if (spotlight.state === 'excluded') {
    return translate(
      'podWorkspace.spotlight.detail.excluded',
      'Spotlight did not find files older than two hours in this folder.'
    )
  }
  switch (spotlight.reason) {
    case 'indexing-disabled':
      return translate(
        'podWorkspace.spotlight.detail.disabled',
        'Spotlight indexing is off for the startup disk.'
      )
    case 'no-old-files':
      return translate(
        'podWorkspace.spotlight.detail.noOldFiles',
        'No tracked files older than two hours yet; Spotlight needs a while to see a new folder.'
      )
    case 'error':
    case null:
      return translate('podWorkspace.spotlight.detail.error', 'Spotlight did not answer in time.')
  }
}

export function timeMachineDestinationDetail(
  destination: PodWorkspaceTimeMachineDestination
): string {
  switch (destination) {
    case 'configured':
      return translate('podWorkspace.timeMachine.destination.configured', 'Backups are configured.')
    case 'none':
      return translate(
        'podWorkspace.timeMachine.destination.none',
        'Backups are not configured. Exclusions still apply once you add a backup disk.'
      )
    case 'unknown':
      return translate(
        'podWorkspace.timeMachine.destination.unknown',
        'Could not read the backup destination.'
      )
  }
}
