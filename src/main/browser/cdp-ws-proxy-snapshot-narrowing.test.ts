import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import { AgentBrowserSnapshotNarrowing } from './agent-browser-snapshot-narrowing'
import { axTree, wrapped } from './ax-tree-test-harness'
import {
  connect,
  createMockWebContents,
  getSendCommandCalls,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

const page = axTree({
  role: 'RootWebArea',
  children: [
    { role: 'main', children: [wrapped(5, { role: 'button', name: 'Save' })] },
    { role: 'contentinfo', children: [{ role: 'list', children: [{ role: 'listitem' }] }] }
  ]
})

describe('CdpWsProxy with snapshot narrowing', () => {
  let proxy: CdpWsProxy | null = null

  afterEach(async () => {
    await proxy?.stop()
    proxy = null
  })

  it("asks Chromium for a cut tree for a depth snapshot, and the whole tree for a ref lookup", async () => {
    const mock = createMockWebContents()
    mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) =>
      method === 'Accessibility.getFullAXTree'
        ? { nodes: page.cut(typeof params?.depth === 'number' ? params.depth : -1) }
        : {}
    )
    const narrowing = new AgentBrowserSnapshotNarrowing()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {}, narrowing)
    const client = await connect(await proxy.start())
    const treeRequests = () =>
      getSendCommandCalls(mock)
        .filter(([method]) => method === 'Accessibility.getFullAXTree')
        .map(([, params]) => params)

    narrowing.expect({ depth: 1, interactive: false })
    const snapshot = await sendAndReceive(client, {
      id: 1,
      method: 'Accessibility.getFullAXTree',
      params: {}
    })
    narrowing.expect(null)

    expect(snapshot.id).toBe(1)
    expect(JSON.stringify(snapshot.result)).toContain('"Save"')
    expect(treeRequests().at(-1)).toEqual({ depth: 7 })

    await sendAndReceive(client, { id: 2, method: 'Accessibility.getFullAXTree', params: {} })
    expect(treeRequests().at(-1)).toEqual({})
    client.close()
  })
})
