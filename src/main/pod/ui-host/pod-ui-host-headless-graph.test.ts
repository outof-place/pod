import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { publishHeadlessRuntimeGraph } from '../../runtime/headless-runtime-graph'

// The headless one-app runtime between fallback windows (pod-ui-host-window.ts republishes).
describe('a headless runtime whose promoted window closed', () => {
  it('serves its own graph again, and promotes the next window as it did the first', async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory census reads only listProcesses.
    runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
    publishHeadlessRuntimeGraph(runtime)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: 1, graphStatus: 'ready' })

    runtime.markGraphUnavailable(1)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: null,
      graphStatus: 'unavailable'
    })
    publishHeadlessRuntimeGraph(runtime)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID,
      graphStatus: 'ready'
    })
    await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toMatchObject({
      authoritative: true
    })

    runtime.attachWindow(2)
    expect(runtime.getStatus()).toMatchObject({
      authoritativeWindowId: 2,
      graphStatus: 'reloading'
    })
    runtime.syncWindowGraph(2, { tabs: [], leaves: [] })
    expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: 2, graphStatus: 'ready' })
  })
})
