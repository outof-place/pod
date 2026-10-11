import { describe, expect, it, vi } from 'vitest'
import { addPodCdpProxySink, podCdpProxyReply, podCdpProxyRequest } from './cdp-proxy-hooks'

describe('Pod CDP proxy hooks', () => {
  it('hand each request and reply to every sink until it is removed', () => {
    const panes = { request: vi.fn() }
    const sleep = { request: vi.fn(), reply: vi.fn() }
    const removePanes = addPodCdpProxySink(panes)
    addPodCdpProxySink(sleep)
    podCdpProxyRequest(41, 7)
    podCdpProxyReply(41, 7)
    expect(panes.request).toHaveBeenCalledWith(41, 7)
    expect(sleep.request).toHaveBeenCalledWith(41, 7)
    expect(sleep.reply).toHaveBeenCalledWith(41, 7)
    removePanes()
    podCdpProxyRequest(41, 8)
    expect(panes.request).toHaveBeenCalledTimes(1)
    expect(sleep.request).toHaveBeenCalledTimes(2)
  })
})
