import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import { AgentBrowserClickMove } from './agent-browser-click-move'
import { connect, createMockWebContents, getSendCommandCalls } from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

function replies(client: WebSocket): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>()
  client.on('message', (data) => {
    const message: Record<string, unknown> = JSON.parse(data.toString())
    if (typeof message.id === 'number') {
      byId.set(message.id, message)
    }
  })
  return byId
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

describe('CdpWsProxy with a click in flight', () => {
  let proxy: CdpWsProxy | null = null

  afterEach(async () => {
    await proxy?.stop()
    proxy = null
  })

  it("answers the click's pointer move before the page's next frame, and sends it ahead of the press", async () => {
    const mock = createMockWebContents()
    // Chromium answers a move only at the page's next frame, which never comes in this test.
    let frame: () => void = () => {}
    mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved') {
        await new Promise<void>((resolve) => {
          frame = resolve
        })
      }
      return {}
    })
    const clickMove = new AgentBrowserClickMove()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {}, { clickMove })
    const client = await connect(await proxy.start())
    const answered = replies(client)
    const move = { type: 'mouseMoved', x: 10, y: 20 }
    const press = { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }

    clickMove.expect()
    client.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: move }))
    await settle()
    expect(answered.get(1)).toEqual({ id: 1, result: {} })
    client.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: press }))
    await settle()
    expect(answered.get(2)).toEqual({ id: 2, result: {} })
    clickMove.done()
    const mouseEvents = getSendCommandCalls(mock).filter(
      ([method]) => method === 'Input.dispatchMouseEvent'
    )
    expect(mouseEvents.map(([, params]) => params?.type)).toEqual(['mouseMoved', 'mousePressed'])

    // A move of no click (a hover) is answered when Chromium answers it.
    client.send(JSON.stringify({ id: 3, method: 'Input.dispatchMouseEvent', params: move }))
    await settle()
    expect(answered.has(3)).toBe(false)
    frame()
    await settle()
    expect(answered.get(3)).toEqual({ id: 3, result: {} })
    client.close()
  })
})
