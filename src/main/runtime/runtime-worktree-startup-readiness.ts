import { isShellProcess } from '../../shared/agent-detection'
import { isExpectedAgentProcess } from '../../shared/agent-process-recognition'
import {
  createDraftPasteReadyScanner,
  resolvePasteReadySignal
} from '../../shared/draft-paste-ready-scanner'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { TerminalForegroundProver } from '../pod/terminal/pod-terminal-foreground-fence'
import {
  buildStartupPaste,
  isStartupShellInFront,
  writeStartupFollowupGuarded,
  writeStartupInputGuarded
} from '../pod/terminal/pod-startup-input-write'

const BRACKETED_PASTE_QUIET_MS = 1500
// Why: an interactive shell turns bracketed paste on at its prompt and off when it runs the typed
// command (`zsh-prompt-runs-command.txt`), so a 2004 before the last `?2004l` is the shell's.
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
// Why: the deadline's last settle check is one foreground read, which over SSH could otherwise hold
// a past-due wait for the channel's 30 s timeout.
const DEADLINE_SETTLE_CHECK_MS = 2_000

export type WorktreeStartupReadinessHost = {
  getPtyId: (handle: string) => string | null
  getForegroundProcess: (ptyId: string) => Promise<string | null>
  hasChildProcesses?: (ptyId: string) => Promise<boolean>
  subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
  readRecentOutput: (ptyId: string) => string | undefined
  write: (ptyId: string, data: string, inputKind: TerminalInputKind) => void
}

// Fork-only (Pod): a host that writes startup input proves the agent first, and tells clients of a
// refusal (pod-startup-input-write.ts).
export type WorktreeStartupWriteHost = WorktreeStartupReadinessHost &
  TerminalForegroundProver & {
    reportStartupInputRefused: (
      terminalHandle: string,
      input: 'draft' | 'followup',
      reason: string
    ) => void
  }

const AGENT_NOT_READY = 'agent_not_ready'

function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function pasteWorktreeStartupDraftWhenReady(
  host: WorktreeStartupWriteHost,
  handle: string,
  draft: WorktreeStartupDraftPaste
): void {
  // Fork-only (Pod): no ready signal while a shell holds the terminal; the draft goes in sanitized,
  // as one guarded write.
  const isShellInFront = (ptyId: string): Promise<boolean> =>
    isStartupShellInFront(host, ptyId, draft.agent)
  void waitForWorktreeStartupDraft(host, handle, draft.agent, { isShellInFront })
    .then(async (ptyId) => {
      if (!ptyId) {
        console.warn('[worktree-create] agent did not become ready for draft paste')
        host.reportStartupInputRefused(handle, 'draft', AGENT_NOT_READY)
        return
      }
      try {
        await writeStartupInputGuarded(host, ptyId, draft.agent, buildStartupPaste(draft.content))
      } catch (error) {
        host.reportStartupInputRefused(handle, 'draft', refusalReason(error))
        throw error
      }
    })
    .catch((error) => console.warn('[worktree-create] failed to paste startup draft:', error))
}

export function sendWorktreeStartupFollowupWhenReady(
  host: WorktreeStartupWriteHost,
  handle: string,
  followup: WorktreeStartupFollowup
): void {
  void deliverWorktreeStartupFollowup(host, handle, followup).catch((error) =>
    console.warn('[worktree-create] startup follow-up prompt refused:', error)
  )
}

/**
 * Types the follow-up once the agent process is in front; true when it was written, false when the
 * agent never came to the front. Fork-only (Pod): pasted, then submitted, as two guarded writes; a
 * write the guard refuses throws `agent_not_in_foreground` to the caller.
 */
export async function deliverWorktreeStartupFollowup(
  host: WorktreeStartupWriteHost,
  handle: string,
  followup: WorktreeStartupFollowup
): Promise<boolean> {
  let ptyId: string | null
  try {
    ptyId = await waitForWorktreeStartupFollowup(host, handle, followup.expectedProcess)
  } catch (error) {
    console.warn('[worktree-create] failed to send startup follow-up prompt:', error)
    return false
  }
  if (!ptyId) {
    console.warn('[worktree-create] agent did not become ready for follow-up prompt')
    host.reportStartupInputRefused(handle, 'followup', AGENT_NOT_READY)
    return false
  }
  try {
    await writeStartupFollowupGuarded(host, ptyId, followup.prompt)
  } catch (error) {
    host.reportStartupInputRefused(handle, 'followup', refusalReason(error))
    throw error
  }
  return true
}

export async function waitForWorktreeStartupFollowup(
  host: WorktreeStartupWriteHost,
  handle: string,
  expectedProcess: string
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId) {
    return null
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    try {
      // Fork-only (Pod): a local pane's foreground group decides, never the tracker's 5 s guess
      // that a just-launched agent is in front; an SSH or Windows pane reads as before.
      const proof = await host.proveTerminalAgentForegroundFence(ptyId, null)
      if (proof) {
        if (proof.verdict === 'agent') {
          return ptyId
        }
        continue
      }
      const foregroundProcess = await host.getForegroundProcess(ptyId)
      if (isExpectedAgentProcess(foregroundProcess, expectedProcess)) {
        return ptyId
      }
      if (attempt >= 4 && !isShellProcess(foregroundProcess ?? '')) {
        if ((await host.hasChildProcesses?.(ptyId).catch(() => false)) ?? false) {
          return ptyId
        }
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return null
}

export type StartupDraftReadinessOptions = {
  timeoutMs?: number
  requireComposerMarker?: boolean
  signal?: AbortSignal
  /** Vetoes a ready signal whose screen still holds something the input must not answer; the
   *  scan continues, so the agent's next marker or quiet window asks again. */
  accept?: (ptyId: string) => boolean | Promise<boolean>
  /**
   * For a launched agent. With it, only output after the shell's last `?2004l` counts, since the
   * shell's own prompt enables bracketed paste too, and a ready signal is dropped while a shell is
   * proven in front: the launch line has not run yet, or the agent exited.
   */
  isShellInFront?: (ptyId: string) => Promise<boolean>
  /** Enter follows the paste, so the agent's submit signal is waited for instead of its draft one. */
  submit?: boolean
}

export function waitForWorktreeStartupDraft(
  host: WorktreeStartupReadinessHost,
  handle: string,
  agent: TuiAgent,
  options: StartupDraftReadinessOptions = {}
): Promise<string | null> {
  const ptyId = host.getPtyId(handle)
  if (!ptyId || options.signal?.aborted) {
    return Promise.resolve(null)
  }
  const signal = resolvePasteReadySignal(TUI_AGENT_CONFIG[agent], options.submit === true)
  const isShellInFront = options.isShellInFront
  return new Promise((resolve) => {
    let settled = false
    let scanner = createDraftPasteReadyScanner(signal)
    let quietTimer: NodeJS.Timeout | null = null
    // A submit signal's fallback: once its grace elapses, every read that still asks for it is a
    // ready signal, settled like any other.
    let graceTimer: NodeJS.Timeout | null = null
    let graceElapsed = false
    let hardTimer: NodeJS.Timeout | null = null
    let deadlineCheckTimer: NodeJS.Timeout | null = null
    let unsubscribe: (() => void) | null = null
    // Bumped at each shell hand-off: a check begun before one must not settle the wait after it.
    let handoffs = 0
    let handoffCarry = ''
    let checking = false
    /** The hand-off count at a signal that fired while a check ran. */
    let recheckAt: number | null = null
    const onAbort = (): void => finish(null)
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (quietTimer) {
        clearTimeout(quietTimer)
      }
      clearGrace()
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      if (deadlineCheckTimer) {
        clearTimeout(deadlineCheckTimer)
      }
      unsubscribe?.()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const clearGrace = (): void => {
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      graceElapsed = false
    }
    /** The screen holds nothing the input must not answer and no shell is proven in front. */
    const passesSettleChecks = async (): Promise<boolean> =>
      (!options.accept || (await options.accept(ptyId))) &&
      !(isShellInFront && (await isShellInFront(ptyId)))
    /** Settles a fired signal once its screen is clear and no shell is proven in front. */
    const settleSignal = async (signalHandoffs: number): Promise<void> => {
      checking = true
      try {
        if (!(await passesSettleChecks())) {
          return
        }
        if (signalHandoffs === handoffs) {
          finish(ptyId)
        }
      } catch {
        // A check that failed is no settle; the agent's next signal asks again.
      } finally {
        checking = false
        const next = recheckAt
        recheckAt = null
        if (next === handoffs && !settled) {
          void settleSignal(next)
        }
      }
    }
    const onSignal = (): void => {
      if (checking) {
        recheckAt = handoffs
        return
      }
      void settleSignal(handoffs)
    }
    /** The part of a chunk after the shell's last hand-off in it, resetting the scan at one. */
    const sinceShellHandoff = (chunk: string): string => {
      const window = handoffCarry + chunk
      // Why 7: one short of the sequence, so a split one is rejoined and never counted twice.
      handoffCarry = window.slice(-(DECRST_BRACKETED_PASTE.length - 1))
      const handoff = window.lastIndexOf(DECRST_BRACKETED_PASTE)
      if (handoff === -1) {
        return chunk
      }
      handoffs += 1
      scanner = createDraftPasteReadyScanner(signal)
      if (quietTimer) {
        clearTimeout(quietTimer)
        quietTimer = null
      }
      clearGrace()
      return window.slice(handoff + DECRST_BRACKETED_PASTE.length)
    }
    const observe = (chunk: string): void => {
      if (settled) {
        return
      }
      const data = isShellInFront ? sinceShellHandoff(chunk) : chunk
      const result = scanner.observe(data)
      if (result.ready) {
        return onSignal()
      }
      if (result.readyAfterMs === null) {
        clearGrace()
      } else if (typeof result.readyAfterMs === 'number') {
        if (graceElapsed) {
          onSignal()
        } else if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null
            graceElapsed = true
            onSignal()
          }, result.readyAfterMs)
        }
      }
      if (result.armQuietTimer && !options.requireComposerMarker) {
        if (quietTimer) {
          clearTimeout(quietTimer)
        }
        quietTimer = setTimeout(onSignal, BRACKETED_PASTE_QUIET_MS)
      }
    }
    options.signal?.addEventListener('abort', onAbort)
    unsubscribe = host.subscribeToData(ptyId, observe)
    // A deadline inside a pending grace is the box rule's verdict, so it gets one last settle check.
    const onDeadline = (): void => {
      if (!graceTimer && !graceElapsed) {
        return finish(null)
      }
      const deadlineHandoffs = handoffs
      deadlineCheckTimer = setTimeout(() => finish(null), DEADLINE_SETTLE_CHECK_MS)
      void passesSettleChecks().then(
        (passes) => finish(passes && deadlineHandoffs === handoffs ? ptyId : null),
        () => finish(null)
      )
    }
    hardTimer = setTimeout(onDeadline, options.timeoutMs ?? resolveDraftPasteReadyTimeoutMs(agent))
    const replay = host.readRecentOutput(ptyId)
    if (replay) {
      observe(replay)
    }
  })
}
