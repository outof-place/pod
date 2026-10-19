// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopExplicitlyClosedTabPtys } from './orca-runtime-stop-explicitly-closed-tab-ptys'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { RuntimeTerminalSplit } from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { Worktree } from '../../shared/worktree/types'
import { assertStartupLineTypeable } from './pod-startup-line-gate'

export class OrcaRuntimeWithSplitTerminal extends OrcaRuntimeWithStopExplicitlyClosedTabPtys {
  async splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty) {
      if (opts.command) {
        await this.assertSplitLineTypeable(opts, livePty.pty.connectionId)
      }
      return await this.splitPtyBackedTerminal(livePty.pty, opts, createdWorktree)
    }
    this.assertGraphReady()
    const { leaf } = this.getLiveLeafForHandle(handle)
    // Why only with a command: an await here would delay every split's notifier by a tick.
    if (opts.command) {
      await this.assertSplitLineTypeable(
        opts,
        leaf.ptyId ? this.ptysById.get(leaf.ptyId)?.connectionId : null
      )
    }
    const direction = opts.direction ?? 'horizontal'

    const newLeafId = randomUUID()

    this.notifier?.splitTerminal(leaf.tabId, leaf.paneRuntimeId, {
      direction,
      command: opts.command,
      worktreeId: leaf.worktreeId,
      sourceLeafId: leaf.leafId,
      telemetrySource: opts.telemetrySource,
      newLeafId
    })

    const newHandle = await this.waitForLeafInTab(leaf.tabId, newLeafId)
    return {
      handle: newHandle,
      tabId: leaf.tabId,
      paneRuntimeId: leaf.paneRuntimeId,
      leafId: newLeafId
    }
  }

  // Fork-only (Pod): a split's line is refused before its pane exists (pod-startup-line-gate.ts).
  private async assertSplitLineTypeable(
    opts: { command?: string; env?: Record<string, string> },
    connectionId: string | null | undefined
  ): Promise<void> {
    await assertStartupLineTypeable({
      command: opts.command,
      launchAgent: undefined,
      connectionId,
      defaultShellSetting: this.store?.getSettings?.().terminalDefaultShell,
      envShell: opts.env?.SHELL
    })
  }
}
