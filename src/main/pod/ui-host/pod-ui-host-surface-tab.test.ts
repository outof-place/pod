import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { podSurfaceFocusChannel, type PodUiHostSessionSource } from './pod-ui-host-surface-tab'

function tab(id: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: 'wt',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function sessions(byHost: Record<string, Tab[]>): PodUiHostSessionSource {
  return {
    getWorkspaceSessionHostIds: () => Object.keys(byHost),
    getWorkspaceSession: (hostId) => ({ unifiedTabs: { wt: byHost[hostId ?? 'local'] ?? [] } })
  }
}

describe('podSurfaceFocusChannel', () => {
  it('sends a terminal through the terminal route and any other tab through the editor route', () => {
    const source = sessions({
      local: [tab('term-1', 'terminal'), tab('/w/a.ts', 'editor'), tab('page-1', 'browser')]
    })
    expect(podSurfaceFocusChannel(source, 'wt', 'term-1')).toBe('ui:focusTerminal')
    expect(podSurfaceFocusChannel(source, 'wt', '/w/a.ts')).toBe('ui:focusEditorTab')
    expect(podSurfaceFocusChannel(source, 'wt', 'page-1')).toBe('ui:focusEditorTab')
  })

  it("finds an SSH worktree's tab in its host's session", () => {
    const source = sessions({ local: [], 'ssh:box': [tab('/srv/a.ts', 'editor')] })
    expect(podSurfaceFocusChannel(source, 'wt', '/srv/a.ts')).toBe('ui:focusEditorTab')
  })

  it('keeps the terminal route for a tab no session holds yet', () => {
    expect(podSurfaceFocusChannel(sessions({ local: [] }), 'wt', 'new-tab')).toBe(
      'ui:focusTerminal'
    )
    expect(podSurfaceFocusChannel(null, 'wt', '/w/a.ts')).toBe('ui:focusTerminal')
  })
})
