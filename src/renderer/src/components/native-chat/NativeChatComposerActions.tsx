import { ArrowUp, CircleAlert, Play, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { NativeChatComposerGoalChip } from './NativeChatComposerGoalChip'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import type { NativeChatContextUsageSummary } from './native-chat-context-usage-summary'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import type { NativeChatComposerPrimaryAction } from './native-chat-composer-primary-action'

export type NativeChatComposerActionsProps = {
  attachDisabled: boolean
  sendDisabled: boolean
  /** What the primary button does (`nativeChatComposerPrimaryAction`). */
  primaryAction: NativeChatComposerPrimaryAction
  /** Shown on the disabled send button: what the user can do to send. */
  sendBlockedReason?: string | null
  /** Storage refused this draft; it is held in memory only. */
  draftNotSaved?: boolean
  isWorking: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  onAttach: () => void
  onSend: () => void
  onStop?: () => void
  /** Releases the held queue when the primary action is Resume. */
  onResume?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  focusComposer?: () => void
  /** Present while the composer is in goal mode; the chip calls it to leave. */
  onExitGoalMode?: () => void
  /** Absent until the session has reported or the transcript can estimate. */
  contextUsage?: NativeChatContextUsageSummary | null
}

export function NativeChatComposerActions({
  attachDisabled,
  sendDisabled,
  primaryAction,
  sendBlockedReason,
  draftNotSaved,
  isWorking,
  isStopping = false,
  onAttach,
  onSend,
  onStop,
  onResume,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest,
  onExitGoalMode,
  contextUsage,
  focusComposer
}: NativeChatComposerActionsProps): React.JSX.Element {
  const stops = primaryAction === 'stop'
  const resumes = primaryAction === 'resume'
  const handleCriticalAction = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // A double-click commonly lands after the first send has started and the button has
    // changed to Stop; ignore the second click instead of cancelling the new turn.
    if (event.detail > 1) {
      return
    }
    if (stops) {
      onStop?.()
    } else if (resumes) {
      onResume?.()
    } else {
      onSend()
    }
  }
  const sendReason = stops || resumes ? null : (sendBlockedReason ?? null)
  const sendButton = (
    <Button
      type="button"
      data-native-chat-critical-action={stops ? 'stop' : undefined}
      aria-label={
        stops
          ? isStopping
            ? translate('components.native-chat.status.stopping', 'Stopping…')
            : translate('components.native-chat.stop', 'Stop the agent')
          : resumes
            ? translate('components.native-chat.queuedMessages.resume', 'Resume')
            : (sendReason ?? translate('components.native-chat.composer.send', 'Send'))
      }
      disabled={sendDisabled || (isWorking && isStopping)}
      onClick={handleCriticalAction}
      variant={stops ? 'secondary' : 'default'}
      size="icon"
      className="size-8 rounded-full pointer-coarse:size-10"
    >
      {stops ? (
        <Square className="size-3.5 fill-current" />
      ) : resumes ? (
        <Play className="size-3.5 fill-current" />
      ) : (
        <ArrowUp className="size-4" />
      )}
    </Button>
  )

  return (
    <div className="flex w-full items-center justify-between gap-2 text-chat-foreground-faint">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('components.native-chat.composer.attach', 'Attach file')}
              disabled={attachDisabled}
              onClick={onAttach}
              className="pointer-coarse:size-11"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.native-chat.composer.attach', 'Attach file')}
          </TooltipContent>
        </Tooltip>
        {onExitGoalMode ? <NativeChatComposerGoalChip onExit={onExitGoalMode} /> : null}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* Why: keep session controls beside the actions they affect. */}
        <NativeChatSessionOptionPickers
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
          focusComposer={focusComposer}
        />
        {contextUsage ? <NativeChatContextUsageRing usage={contextUsage} /> : null}
        <DraftNotSavedIcon shown={draftNotSaved === true} />
        {sendReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer events, so the wrapper carries the hover. */}
              <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {sendReason}
            </TooltipContent>
          </Tooltip>
        ) : (
          sendButton
        )}
      </div>
    </div>
  )
}

/** Shown only after storage refused the draft, so it never appears on a normal save. */
function DraftNotSavedIcon({ shown }: { shown: boolean }): React.JSX.Element | null {
  if (!shown) {
    return null
  }
  const explanation = translate(
    'components.native-chat.composer.draftNotSaved',
    "This draft couldn't be saved yet. Orca keeps trying."
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={explanation} className="inline-flex text-status-warning">
          <CircleAlert className="size-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {explanation}
      </TooltipContent>
    </Tooltip>
  )
}
