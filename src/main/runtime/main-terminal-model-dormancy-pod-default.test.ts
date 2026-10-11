// Fork-only (Pod): Pod's default keeps main's terminal model live, which keeps two bugs the
// maintainer reproduced when closing stablyai/orca#27207 and #27123 out of Pod builds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { FakeDaemonModel } from './fake-daemon-terminal-model.test-fixture'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from './main-terminal-model-dormancy'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty
} from '../ipc/pty-hidden-delivery-gate'

type DormancySettings = Pick<
  GlobalSettings,
  'terminalMainModelDormancy' | 'podTerminalMainModelDormancy'
>
// What a profile from an earlier Pod build loads as: Orca's stored default on, Pod's default off.
const POD_SETTINGS: DormancySettings = {
  terminalMainModelDormancy: true,
  podTerminalMainModelDormancy: false
}
const ORCA_SETTINGS: DormancySettings = { terminalMainModelDormancy: true }
const CODEX_SIZE = { cols: 120, rows: 40 }
const GRID = { cols: 80, rows: 24 }

type RuntimeWithStore = { store: { getSettings: () => object } | null }

function stubRuntimeSettings(runtime: object, settings: DormancySettings): void {
  const internals = runtime as unknown as RuntimeWithStore
  if (internals.store) {
    vi.spyOn(internals.store, 'getSettings').mockReturnValue(settings)
  } else {
    internals.store = { getSettings: () => settings }
  }
}

// A quiet Antigravity pane whose daemon rebuild never lands; the recording reads ready as text
// but busy on screen, so only a live screen keeps it from reading idle.
async function createBusyAntigravityPane(settings: DormancySettings) {
  const daemon = new FakeDaemonModel(CODEX_SIZE)
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    launchAgent: 'antigravity',
    size: CODEX_SIZE,
    data: '',
    settledDaemonSnapshot: () => new Promise<never>(() => {})
  })
  stubRuntimeSettings(pane.runtime, settings)
  vi.useFakeTimers({ toFake: ['Date'] })
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  }
  await emit(readRuntimeFixture('antigravity-1-2-14-busy-streaming'))
  await pane.runtime.readTerminal(pane.handle, { screen: true })
  vi.setSystemTime(Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS)
  await emit('\x1b[?25l')
  return pane
}

describe('Pod default: main terminal model stays live', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never reports a busy agent idle when its rebuild would never land', async () => {
    const pane = await createBusyAntigravityPane(POD_SETTINGS)
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(false)
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      now: Date.now()
    })
    const waiting = pane.runtime.waitForTerminal(pane.handle, {
      condition: 'tui-idle',
      timeoutMs: 6_000
    })
    void waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(waiting).rejects.toThrow(/timeout/)
  }, 15_000)

  it("lets the same pane rest under Orca's setting alone", async () => {
    const pane = await createBusyAntigravityPane(ORCA_SETTINGS)
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
  })
})

describe('Pod default: no daemon query responder delegation', () => {
  let now = 1_000_000

  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  async function hiddenDelegablePane(settings: DormancySettings): Promise<boolean[]> {
    const daemon = new FakeDaemonModel(GRID)
    const requests: boolean[] = []
    const runtime = createRuntime()
    stubRuntimeSettings(runtime, settings)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => GRID,
      canProvideSettledBufferSnapshot: () => true,
      hasRendererSerializer: () => true,
      serializeProviderBuffer: async () => daemon.snapshot(),
      canDelegateDaemonQueryResponder: () => true,
      setDaemonQueryResponder: (_ptyId, responder) => {
        requests.push(responder)
        return true
      }
    })
    syncSinglePty(runtime, 'pty-1')
    await daemon.feed('one\r\n')
    runtime.onPtyData('pty-1', 'one\r\n', now)
    markHiddenRendererPty('pty-1')
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await daemon.feed('two\r\n')
    runtime.onPtyData('pty-1', 'two\r\n', now)
    return requests
  }

  it('keeps main as the responder of a hidden local pane', async () => {
    expect(await hiddenDelegablePane(POD_SETTINGS)).toEqual([])
  })

  it("hands it to the daemon under Orca's setting alone", async () => {
    expect(await hiddenDelegablePane(ORCA_SETTINGS)).toContain(true)
  })
})
