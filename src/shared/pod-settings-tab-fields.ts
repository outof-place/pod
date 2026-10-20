// Fork-only (Pod): podSettings fields about tabs, which PodNative's tab strip and explorer follow.
import { z } from 'zod'
import { row } from './pod-settings-row'

export const POD_SETTINGS_TAB_FIELDS = {
  ctrlTabOrderMode: row(z.enum(['mru', 'sequential']), 'Tab order for ⌃⇥', 'Recent or tab strip.'),
  editorPreviewTabsEnabled: row(
    z.boolean(),
    'Reuse a preview tab when browsing files',
    'A single click on a file, or a Markdown link, reuses one italic tab until you edit or keep it.'
  ),
  confirmClosePinnedTab: row(z.boolean(), 'Confirm before closing pinned tabs')
}
