// Fork-only (Pod): the workspace board button is part of the tasks cut (src/shared/product/features.ts).
import React from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { POD_TASKS } from '../../../../shared/product/features'

// Why a wrapper: swapping the tag gates the button without re-indenting upstream JSX.
export function WorkspaceBoardTooltip(
  props: React.ComponentProps<typeof Tooltip>
): React.JSX.Element | null {
  return POD_TASKS ? <Tooltip {...props} /> : null
}
