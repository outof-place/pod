import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  uiHost: false
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))
vi.mock('../pod/ui-host/pod-ui-host-launch', () => ({ isPodUiHostLaunch: () => mocks.uiHost }))
vi.mock('../native-terminal/ghostty-native-terminal-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isNativeTerminalSupported: () => true,
  installNativeTerminalDebugHooks: vi.fn()
}))

const { registerNativeTerminalHandlers } = await import('./native-terminal')

describe('nativeTerminal:isSupported', () => {
  it("is false in one-app's runtime, whose hidden window draws no Ghostty views", () => {
    registerNativeTerminalHandlers()
    const isSupported = mocks.handlers.get('nativeTerminal:isSupported')
    expect(isSupported?.()).toBe(true)
    mocks.uiHost = true
    expect(isSupported?.()).toBe(false)
  })
})
