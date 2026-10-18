import { RuntimeBrowserCommandsWithListLogicalBrowserTabs } from './runtime-browser-commands-list-logical-browser-tabs'
import type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
import { BrowserError } from '../browser/browser-error'
import type { CobrowseBox } from '../../shared/browser-cobrowse-types'

export class RuntimeBrowserCommands extends RuntimeBrowserCommandsWithListLogicalBrowserTabs {
  // Fork-only (Pod): co-browse's page, resolved as every browser verb resolves its target.
  async browserCobrowseTarget(
    params: BrowserCommandTargetParams
  ): Promise<{ worktreeId?: string; browserPageId: string }> {
    const target = await this.resolveBrowserCommandTarget(params)
    const browserPageId = this.requireAgentBrowserBridge().getActivePageId(
      target.worktreeId,
      target.browserPageId
    )
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { worktreeId: target.worktreeId, browserPageId }
  }

  // Fork-only (Pod): where agent-browser finds a locator of its own (@e3, text=...), viewport CSS px.
  async browserElementBox(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<CobrowseBox> {
    const target = await this.resolveBrowserCommandTarget(params)
    const reply = await this.requireAgentBrowserBridge().get(
      'box',
      params.element,
      target.worktreeId,
      target.browserPageId
    )
    const box = readBox(reply)
    if (!box) {
      throw new BrowserError('browser_element_not_found', `No element for ${params.element}`)
    }
    return box
  }
}

function readBox(reply: unknown): CobrowseBox | null {
  const outer =
    typeof reply === 'object' && reply !== null ? Object.fromEntries(Object.entries(reply)) : {}
  const inner =
    typeof outer.box === 'object' && outer.box !== null
      ? Object.fromEntries(Object.entries(outer.box))
      : outer
  const { x, y, width, height } = inner
  return typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number'
    ? { x, y, width, height }
    : null
}
export type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
export type { RuntimeBrowserCommandHost } from './runtime-browser-commands-browser-command-target-params'
