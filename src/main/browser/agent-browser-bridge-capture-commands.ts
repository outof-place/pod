import type { BrowserScreenshotResult, BrowserEvalResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { captureFullPageScreenshot, captureScreenshot } from './cdp-screenshot'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { AgentBrowserBridgeUtilityCommands } from './agent-browser-bridge-utility-commands'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { notePodAgentBrowserCommand } from '../pod/browser-pane/pod-browser-pane-hooks'

export abstract class AgentBrowserBridgeCaptureCommands extends AgentBrowserBridgeUtilityCommands {
  async screenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why direct: a capture is one CDP call on this page's own webContents; a helper process per shot only adds its start-up.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        const imageFormat = format === 'jpeg' ? 'jpeg' : 'png'
        notePodAgentBrowserCommand(target.webContentsId)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          // Why: Chromium's fast PNG encoder (its screencast's) saves ~25 ms a capture for ~40% more bytes.
          const { data } = await captureScreenshot(
            wc,
            { format: imageFormat, optimizeForSpeed: true },
            () => this.browserManager.holdPaintForCapture(target.webContentsId)
          )
          return { data, format: imageFormat }
        } catch (error) {
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(
              `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
            )
          }
          throw new BrowserError(
            'browser_error',
            error instanceof Error ? error.message : String(error)
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false }
    )
  }

  async fullPageScreenshot(
    format?: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserScreenshotResult> {
    // Why no helper session: like the viewport shot, this is CDP on the page's own webContents.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        notePodAgentBrowserCommand(target.webContentsId)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          return await captureFullPageScreenshot(wc, format === 'jpeg' ? 'jpeg' : 'png', () =>
            this.browserManager.holdPaintForCapture(target.webContentsId)
          )
        } catch (error) {
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(
              `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
            )
          }
          throw new BrowserError(
            'browser_error',
            error instanceof Error ? error.message : String(error)
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false }
    )
  }

  async evaluate(
    expression: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserEvalResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        let releaseDebugger = (): void => {}
        try {
          releaseDebugger = acquireElectronDebugger(wc).release
          const { result, exceptionDetails } = (await wc.debugger.sendCommand('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
          })) as {
            result: { value?: unknown; description?: string }
            exceptionDetails?: { text: string; exception?: { description?: string } }
          }
          if (exceptionDetails) {
            throw new BrowserError(
              'browser_eval_error',
              exceptionDetails.exception?.description ?? exceptionDetails.text
            )
          }

          const currentTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
          if (currentTarget.webContentsId !== target.webContentsId) {
            throw new BrowserError(
              'browser_tab_changed',
              `Browser page ${target.browserPageId} changed while evaluating; retry the command`
            )
          }
          return {
            result:
              result.value !== undefined
                ? typeof result.value === 'object' && result.value !== null
                  ? JSON.stringify(result.value)
                  : String(result.value)
                : (result.description ?? ''),
            origin: wc.getURL()
          }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(
              `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
            )
          }
          throw new BrowserError(
            'browser_error',
            `Failed to evaluate in browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          releaseDebugger()
        }
      },
      { ensureSession: false }
    )
  }
}
