import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import { finishPtyShutdown } from '../provider/liveness'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

function makeDeps(
  prepareCodexResumeHome: PtyRuntimeControllerDeps['prepareCodexResumeHome']
): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    store: undefined,
    getSettings: () => getDefaultSettings('/tmp'),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `operations.ts` (write/clearBuffer) reads `mainWindow`; the spawn preflight and option build never touch it, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

async function resumeHomeArgs(extra: Partial<RuntimePtySpawnArgs>): Promise<unknown> {
  const prepareCodexResumeHome = vi.fn().mockReturnValue(null)
  const args: RuntimePtySpawnArgs = {
    cols: 120,
    rows: 40,
    command: "codex 'resume' 'sess-1'",
    launchAgent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'sess-1' },
    ...extra
  }
  await prepareRuntimePtySpawn(createRuntimePtySpawnState(makeDeps(prepareCodexResumeHome), args))
  return prepareCodexResumeHome.mock.calls[0]?.[0]
}

describe('runtime pty spawn preflight: codexAccountRestart (Pod)', () => {
  it('moves the resumed session into the selected account only when asked', async () => {
    await expect(resumeHomeArgs({ codexAccountRestart: true })).resolves.toMatchObject({
      launchAgent: 'codex',
      useSelectedAccount: true
    })
    await expect(resumeHomeArgs({})).resolves.not.toHaveProperty('useSelectedAccount')
  })
})
