import { describe, expect, it } from 'vitest'
import { resolveSimHelperBinary, simHelperCandidates } from './sim-helper-path'

const DEV = 'native/pod-sim-macos/.build/release/pod-sim'

describe('pod-sim binary path', () => {
  it('outside a packaged Pod: the override, then the app resources, then the checkout', () => {
    const options = {
      packaged: false,
      env: { POD_SIM_HELPER_BINARY: '/probe/pod-sim' },
      resourcesPath: '/Applications/Pod.app/Contents/Resources',
      cwd: '/src/pod',
      moduleDir: '/src/pod/out/main'
    }
    expect(simHelperCandidates(options)).toEqual([
      '/probe/pod-sim',
      '/Applications/Pod.app/Contents/Resources/bin/pod-sim',
      `/src/pod/${DEV}`,
      `/src/pod/${DEV}`
    ])
    const packagedOnly = (path: string) => path.startsWith('/Applications/')
    expect(resolveSimHelperBinary({ ...options, exists: packagedOnly })).toBe(
      '/Applications/Pod.app/Contents/Resources/bin/pod-sim'
    )
  })

  it('a packaged Pod runs only the helper it ships: no override, no checkout', () => {
    const options = {
      packaged: true,
      env: { POD_SIM_HELPER_BINARY: '/probe/pod-sim' },
      resourcesPath: '/Applications/Pod.app/Contents/Resources',
      cwd: '/src/pod',
      moduleDir: '/src/pod/out/main'
    }
    expect(simHelperCandidates(options)).toEqual([
      '/Applications/Pod.app/Contents/Resources/bin/pod-sim'
    ])
    expect(
      resolveSimHelperBinary({ ...options, exists: (path) => path === '/probe/pod-sim' })
    ).toBe(null)
  })

  it('finds nothing when no candidate exists, so the client reports notFound', () => {
    expect(
      resolveSimHelperBinary({
        packaged: false,
        env: {},
        resourcesPath: undefined,
        cwd: '/nowhere',
        exists: () => false
      })
    ).toBeNull()
  })
})
