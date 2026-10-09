import { translate } from '@/i18n/i18n'
import type { PodWorkspaceRootIssueCode } from '../../../../shared/pod-workspace-types'

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
