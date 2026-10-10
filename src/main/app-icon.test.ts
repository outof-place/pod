import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  browserWindowGetAllWindowsMock,
  createFromPathMock,
  dockSetIconMock,
  isMock,
  windowSetIconMock
} = vi.hoisted(() => ({
  appMock: { dock: { setIcon: vi.fn() }, isPackaged: false },
  browserWindowGetAllWindowsMock: vi.fn(),
  createFromPathMock: vi.fn(),
  dockSetIconMock: vi.fn(),
  isMock: { dev: false },
  windowSetIconMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  nativeImage: { createFromPath: createFromPathMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('../../resources/icon.png?asset', () => ({
  default: 'classic-icon'
}))

vi.mock('../../resources/icon-dev.png?asset', () => ({
  default: 'classic-dev-icon'
}))

import { applyAppIcon, getAppIconPath } from './app-icon'

describe('app icon', () => {
  beforeEach(() => {
    browserWindowGetAllWindowsMock.mockReset()
    createFromPathMock.mockReset()
    dockSetIconMock.mockReset()
    windowSetIconMock.mockReset()
    appMock.dock.setIcon = dockSetIconMock
    appMock.isPackaged = false
  })

  it("resolves Orca's retired alternates and invalid ids to Pod's icon", () => {
    expect(getAppIconPath('classic')).toBe('classic-icon')
    expect(getAppIconPath('watercolor')).toBe('classic-icon')
    expect(getAppIconPath('blue')).toBe('classic-icon')
    expect(getAppIconPath('missing')).toBe('classic-icon')
  })

  it('applies the icon to the dock and live windows in unpackaged builds', () => {
    const image = { isEmpty: () => false }
    createFromPathMock.mockReturnValue(image)
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, setIcon: windowSetIconMock },
      { isDestroyed: () => true, setIcon: vi.fn() }
    ])

    applyAppIcon('watercolor')

    expect(createFromPathMock).toHaveBeenCalledWith('classic-icon')
    if (process.platform === 'darwin') {
      expect(dockSetIconMock).toHaveBeenCalledWith(image)
    } else {
      expect(dockSetIconMock).not.toHaveBeenCalled()
    }
    expect(windowSetIconMock).toHaveBeenCalledWith(image)
  })

  it("leaves a packaged app's Dock tile to the bundle icon", () => {
    const image = { isEmpty: () => false }
    createFromPathMock.mockReturnValue(image)
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, setIcon: windowSetIconMock }
    ])
    appMock.isPackaged = true

    applyAppIcon('classic')

    expect(dockSetIconMock).not.toHaveBeenCalled()
    expect(windowSetIconMock).toHaveBeenCalledWith(image)
  })

  it('leaves the dock and windows alone when the icon image is empty', () => {
    createFromPathMock.mockReturnValue({ isEmpty: () => true })

    applyAppIcon('classic')

    expect(dockSetIconMock).not.toHaveBeenCalled()
    expect(browserWindowGetAllWindowsMock).not.toHaveBeenCalled()
  })
})
