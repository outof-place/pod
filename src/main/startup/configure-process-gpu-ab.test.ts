import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
    disableHardwareAcceleration: vi.fn(),
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: vi.fn(() => '')
    }
  }
}))

// Fork-only GPU A/B switches; kept apart so configure-process.test.ts stays under max-lines.
describe('enableMainProcessGpuFeatures fork A/B switches', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform
    })
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('paces macOS frames with CADisplayLink unless ORCA_CADISPLAYLINK=0', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')
    const original = process.env.ORCA_CADISPLAYLINK

    try {
      delete process.env.ORCA_E2E_USER_DATA_DIR
      setPlatform('darwin')
      for (const [value, expected] of [
        [undefined, true],
        ['0', false]
      ] as const) {
        if (value === undefined) {
          delete process.env.ORCA_CADISPLAYLINK
        } else {
          process.env.ORCA_CADISPLAYLINK = value
        }
        vi.mocked(app.commandLine.appendSwitch).mockClear()
        enableMainProcessGpuFeatures()
        const features = vi
          .mocked(app.commandLine.appendSwitch)
          .mock.calls.find(([name]) => name === 'enable-features')?.[1]
        expect(features?.includes('CADisplayLinkInBrowser')).toBe(expected)
      }
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_CADISPLAYLINK
      } else {
        process.env.ORCA_CADISPLAYLINK = original
      }
    }
  })

  it('keeps Skia Graphite on macOS only when ORCA_SKIA_GRAPHITE=1', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./configure-process')
    const original = process.env.ORCA_SKIA_GRAPHITE

    try {
      delete process.env.ORCA_E2E_USER_DATA_DIR
      setPlatform('darwin')
      process.env.ORCA_SKIA_GRAPHITE = '1'
      vi.mocked(app.commandLine.appendSwitch).mockClear()
      enableMainProcessGpuFeatures()
      expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('disable-skia-graphite')
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_SKIA_GRAPHITE
      } else {
        process.env.ORCA_SKIA_GRAPHITE = original
      }
    }
  })
})
