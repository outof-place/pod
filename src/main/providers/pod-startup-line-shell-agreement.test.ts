import { basename } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nameLocalTypedLineShell } from '../runtime/agent-launch-typed-line-shell'
import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'

vi.mock('./local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

afterEach(() => vi.unstubAllEnvs())

// Pod: gate B (runtime/pod-startup-line-gate.ts) names the shell before the spawn; the local
// provider must spawn that same shell, or a line the gate passed is refused only after the tab.
describe.skipIf(process.platform === 'win32')('gate B and the local spawn name one shell', () => {
  it.each([
    ['/bin/ksh', '/bin/zsh', undefined, '/bin/bash'],
    [undefined, '/usr/bin/fish', '/bin/ksh', '/bin/bash'],
    [undefined, undefined, '/bin/ksh', '/bin/zsh'],
    [undefined, undefined, undefined, '/bin/tcsh'],
    [undefined, undefined, undefined, undefined]
  ])(
    'override %s, setting %s, spawn SHELL %s, process SHELL %s',
    (override, setting, spawnEnvShell, processShell) => {
      vi.stubEnv('SHELL', processShell)
      // Why `override ?? setting`: the runtime spawn (ipc/pty/runtime/spawn-preflight.ts) hands a
      // local spawn the default-shell setting as its shell override.
      const plan = createLocalPtyLaunchPlan(
        {
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          ...((override ?? setting) ? { shellOverride: override ?? setting } : {}),
          ...(spawnEnvShell ? { env: { SHELL: spawnEnvShell } } : {})
        },
        () => ({ getDefaultShell: () => setting ?? '' })
      )
      expect('shellPath' in plan ? basename(plan.shellPath) : null).toBe(
        nameLocalTypedLineShell({
          isRemote: false,
          ...(override ? { shellOverride: override } : {}),
          ...(setting ? { defaultShellSetting: setting } : {}),
          ...(spawnEnvShell ? { envShell: spawnEnvShell } : {})
        })
      )
    }
  )
})
