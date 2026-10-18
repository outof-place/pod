// Fork-only (Pod): co-browse's agent verbs. `browser.marks` hands the agent working a tab what the user
// marked on it (waiting for them on request); `browser.point` shows the user where the agent means.
// The runtime that hosts the page owns both, so an SSH worktree's agent reaches them the same way.
import { defineMethod } from '../../runtime/rpc/core'
import { BrowserError } from '../../browser/browser-error'
import { podBrowserCobrowse } from '../browser-pane/pod-browser-pane-hooks'
import { BrowserMarks, BrowserPoint } from '../../../shared/rpc-contract/browser-cobrowse-params'
import {
  COBROWSE_LIMITS,
  formatCobrowseMarksMarkdown,
  type CobrowseMarksResult,
  type CobrowsePointResult
} from '../../../shared/browser-cobrowse-types'

export const POD_BROWSER_COBROWSE_RPC = { marks: 'browser.marks', point: 'browser.point' } as const

// agent-browser's own locator syntaxes, which only its daemon resolves (refs live in its snapshot).
const AGENT_BROWSER_LOCATOR = /^(@|(text|xpath|role|label|placeholder|alt|title|testid)=)/

function unavailable(browserPageId: string): BrowserError {
  return new BrowserError(
    'browser_cobrowse_unavailable',
    `Marks and pointers need a Pod browser pane; page ${browserPageId} is not shown in one.`
  )
}

function sink(): NonNullable<ReturnType<typeof podBrowserCobrowse>> {
  const cobrowse = podBrowserCobrowse()
  if (!cobrowse) {
    throw new BrowserError(
      'browser_cobrowse_unavailable',
      'Marks and pointers need Pod with its native browser panes.'
    )
  }
  return cobrowse
}

export const POD_BROWSER_COBROWSE_METHODS = [
  defineMethod({
    name: POD_BROWSER_COBROWSE_RPC.marks,
    permission: 'workspace',
    params: BrowserMarks,
    handler: async (params, { runtime, signal }): Promise<CobrowseMarksResult> => {
      const cobrowse = sink()
      const { browserPageId } = await runtime.browserCobrowseTarget(params)
      const result = cobrowse.marks(browserPageId, {
        wait: params.wait === true,
        timeoutMs: Math.min(
          params.timeout ?? COBROWSE_LIMITS.waitDefaultMs,
          COBROWSE_LIMITS.waitMaxMs
        ),
        peek: params.peek === true,
        signal
      })
      if (!result) {
        throw unavailable(browserPageId)
      }
      const taken = await result
      // Pod's Copy as Markdown reads the page's marks as the agent would (one formatter for both).
      return params.peek === true
        ? { ...taken, markdown: formatCobrowseMarksMarkdown(taken.marks) }
        : taken
    }
  }),
  defineMethod({
    name: POD_BROWSER_COBROWSE_RPC.point,
    permission: 'workspace',
    params: BrowserPoint,
    handler: async (params, { runtime }): Promise<CobrowsePointResult> => {
      const cobrowse = sink()
      const { browserPageId, worktreeId } = await runtime.browserCobrowseTarget(params)
      const label = params.label ?? ''
      const keep = params.keep === true
      let reply: Awaited<ReturnType<typeof cobrowse.point>>
      try {
        if (params.clear === true) {
          reply = await cobrowse.point(browserPageId, { clear: true, pointerId: params.pointer })
        } else if (params.element !== undefined && AGENT_BROWSER_LOCATOR.test(params.element)) {
          const box = await runtime.browserElementBox({
            element: params.element,
            worktree: worktreeId,
            page: browserPageId
          })
          reply = await cobrowse.point(browserPageId, { box, label, keep })
        } else if (params.element !== undefined) {
          reply = await cobrowse.point(browserPageId, { selector: params.element, label, keep })
        } else {
          const region = {
            x: params.x ?? 0,
            y: params.y ?? 0,
            width: params.width ?? 0,
            height: params.height ?? 0
          }
          reply = await cobrowse.point(browserPageId, { region, label, keep })
        }
      } catch (error) {
        if (error instanceof BrowserError) {
          throw error
        }
        throw new BrowserError(
          'browser_element_not_found',
          error instanceof Error ? error.message : String(error)
        )
      }
      if (!reply) {
        throw unavailable(browserPageId)
      }
      return { browserPageId, ...reply }
    }
  })
]
