// Fork-only (Pod): keeps one pod-sim helper running for the runtime. Every device of every agent
// sits behind this one process, so a recycle drops them all: the helper answers `timeout` itself
// past each method's deadline, and only a helper silent past that plus a margin is replaced. A
// crash restarts it after a backoff; booted devices survive it (CoreSimulator owns them). Every
// call answers a typed result, and nothing here throws, from a call or from a timer. Live views
// (startStream) outlive a replacement: the new helper streams them again, each viewer's rendezvous
// name still checked in, and other devices' views come back after the restart's short gap.
import { randomBytes } from 'node:crypto'
import { SimHelperConnection, type SimHelperSpawner } from './sim-helper-connection'
import { actOnSimHelperEvent, type SimHelperEvent } from './sim-helper-events'
import { SimHelperLiveViews } from './sim-helper-live-views'
import { simHelperEnvironment, type SimHelperLaunchOptions } from './sim-helper-env'
import { resolveSimHelperBinary, simHelperBinaryStamp } from './sim-helper-path'
import {
  SIM_HELPER_METHODS,
  simHelperCallBudgetMs,
  type SimHelperMethod,
  type SimHelperParams,
  type SimHelperReport,
  type SimHelperValue
} from './sim-helper-protocol'
import {
  simHelperFailed,
  simHelperUnavailable,
  type SimHelperFailure,
  type SimHelperResult
} from './sim-helper-result'

export type SimHelperState =
  | { state: 'idle' }
  | { state: 'starting'; attempt: number }
  | { state: 'ready'; pid: number | undefined; hello: SimHelperReport }
  | { state: 'restarting'; failure: SimHelperFailure; attempt: number; retryAt: number }
  // Not retried on a timer. notMacOS, notFound: the next call looks again. tokenMismatch,
  // protocolMismatch: the next call spawns again only once the binary at that path changed.
  | { state: 'unavailable'; failure: SimHelperFailure }
  | { state: 'stopped' }

/** 250 ms doubling to a 30 s cap: a helper that crashes on start costs one spawn every 30 s. */
export function simHelperRestartDelayMs(attempt: number): number {
  return Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1))
}

export type SimHelperSupervisorOptions = SimHelperLaunchOptions & {
  /** `app.isPackaged`, passed by the Electron side: a packaged Pod runs only its bundled helper. */
  packaged: boolean
  platform?: NodeJS.Platform
  /** Where the helper's allowlisted variables come from; nothing else of it reaches the helper. */
  env?: Readonly<Record<string, string | undefined>>
  resolveBinary?: () => string | null
  /** How long a call waits for a helper that is starting or restarting. */
  readyTimeoutMs?: number
  helloTimeoutMs?: number
  /** A call's time in flight, after the helper is ready: its deadline plus the margin. */
  callBudgetMs?: (method: SimHelperMethod) => number
  restartDelayMs?: (attempt: number) => number
  /** A helper up this long resets the backoff. */
  stableAfterMs?: number
  spawn?: SimHelperSpawner
  log?: (message: string) => void
  onState?: (state: SimHelperState) => void
  /** Each event of the running helper once acted on, and streamEnded (helperRestart) for a refused replay. */
  onEvent?: (event: SimHelperEvent) => void
}

type Ready = { connection: SimHelperConnection; hello: SimHelperReport }

export class SimHelperSupervisor {
  private current: SimHelperState = { state: 'idle' }
  private connection: SimHelperConnection | null = null
  private attempt = 0
  // Restarts since the last helper that lived stableAfterMs: the backoff's attempt number.
  private failures = 0
  private readySince = 0
  private restartTimer: NodeJS.Timeout | null = null
  private waiters: (() => void)[] = []
  // The build that refused this runtime's token or protocol; refused again until it changes.
  private refused: { binary: string; stamp: string | null } | null = null
  private readonly liveViews = new SimHelperLiveViews()
  private readonly log: (message: string) => void

  constructor(private readonly options: SimHelperSupervisorOptions) {
    this.log = options.log ?? ((message) => console.warn(`[pod-sim] ${message}`))
  }

  state(): SimHelperState {
    return this.current
  }

  /** Starts the helper if nothing is running or scheduled, and no unchanged build refused us. */
  start(): void {
    const { state } = this.current
    if (state === 'idle' || (state === 'unavailable' && !this.stillRefused())) {
      this.launch()
    }
  }

  /** The start-up self-test of the running helper: versions and each capability's verdict. */
  async hello(
    readyTimeoutMs = this.options.readyTimeoutMs ?? 15_000
  ): Promise<SimHelperResult<SimHelperReport>> {
    const ready = await this.whenReady(Date.now() + readyTimeoutMs)
    return ready.ok ? { ok: true, value: ready.value.hello } : ready
  }

  async call<M extends SimHelperMethod>(
    method: M,
    params: SimHelperParams<M>
  ): Promise<SimHelperResult<SimHelperValue<M>>> {
    this.liveViews.calling(method, params)
    const ready = await this.whenReady(Date.now() + (this.options.readyTimeoutMs ?? 15_000))
    if (!ready.ok) {
      return ready
    }
    const { connection } = ready.value
    const budgetMs = (this.options.callBudgetMs ?? simHelperCallBudgetMs)(method)
    const reply = await connection.call(method, params, budgetMs)
    if (!reply.ok) {
      if (reply.failure.kind === 'unavailable' && reply.failure.reason === 'timeout') {
        // Silent past its own deadline: a private call that never returns. Replace the process.
        const failure = simHelperUnavailable(
          'timeout',
          `${method} had no answer in ${budgetMs} ms, past the helper's own deadline`
        )
        this.log(`${failure.message}; recycling the helper`)
        connection.kill(failure)
        return simHelperFailed(failure)
      }
      return reply
    }
    const parsed = SIM_HELPER_METHODS[method].result.safeParse(reply.value)
    if (!parsed.success) {
      return simHelperFailed({
        kind: 'error',
        code: 'internal',
        message: `${method} answered an unknown shape`
      })
    }
    this.liveViews.accepted(method, params)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed by SIM_HELPER_METHODS[method].result, the schema SimHelperValue<M> is inferred from.
    return { ok: true, value: parsed.data as SimHelperValue<M> }
  }

  async stop(): Promise<void> {
    this.clearRestart()
    const connection = this.connection
    this.connection = null
    this.setState({ state: 'stopped' })
    await connection?.close(2_000)
  }

  private async whenReady(deadline: number): Promise<SimHelperResult<Ready>> {
    for (;;) {
      const state = this.current
      if (state.state === 'ready' && this.connection) {
        return { ok: true, value: { connection: this.connection, hello: state.hello } }
      }
      if (state.state === 'stopped') {
        return simHelperFailed(simHelperUnavailable('stopped'))
      }
      if (state.state === 'unavailable' && this.stillRefused()) {
        return simHelperFailed(state.failure)
      }
      if (state.state === 'idle' || state.state === 'unavailable') {
        this.launch()
        if (this.current.state === 'unavailable') {
          return simHelperFailed(this.current.failure)
        }
        continue
      }
      if (state.state === 'restarting' && state.retryAt > deadline) {
        return simHelperFailed(state.failure)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return simHelperFailed(
          state.state === 'restarting'
            ? state.failure
            : simHelperUnavailable('timeout', 'helper still starting')
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** True while the binary that refused us is still the one a launch would run. */
  private stillRefused(): boolean {
    if (!this.refused) {
      return false
    }
    const binary = this.resolveBinary()
    if (binary === this.refused.binary && simHelperBinaryStamp(binary) === this.refused.stamp) {
      return true
    }
    this.refused = null
    return false
  }

  /** From start(), a call or the restart timer: whatever goes wrong becomes a state, never a throw. */
  private launch(): void {
    try {
      this.spawnHelper()
    } catch (error) {
      this.connection = null
      this.scheduleRestart(
        simHelperUnavailable('spawnFailed', error instanceof Error ? error.message : String(error))
      )
    }
  }

  private spawnHelper(): void {
    this.clearRestart()
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      this.setState({ state: 'unavailable', failure: simHelperUnavailable('notMacOS') })
      return
    }
    const binary = this.resolveBinary()
    if (!binary) {
      this.setState({
        state: 'unavailable',
        failure: simHelperUnavailable('notFound', 'no pod-sim binary')
      })
      return
    }
    this.attempt += 1
    const connection = new SimHelperConnection({
      binary,
      env: simHelperEnvironment(this.options.env ?? process.env, this.options),
      token: randomBytes(32).toString('hex'),
      spawn: this.options.spawn,
      log: this.log,
      onExit: (failure) => this.onExit(connection, failure),
      onEvent: (event) => this.onEvent(connection, event)
    })
    this.connection = connection
    this.setState({ state: 'starting', attempt: this.attempt })
    void connection.hello(this.options.helloTimeoutMs ?? 15_000).then((hello) => {
      if (this.connection !== connection) {
        return
      }
      if (hello.ok) {
        this.readySince = Date.now()
        this.setState({ state: 'ready', pid: connection.pid, hello: hello.value })
        // Live views of the helper this one replaced (none on a first start).
        const budgetMs = (this.options.callBudgetMs ?? simHelperCallBudgetMs)('startStream')
        void this.liveViews.replay(
          connection,
          budgetMs,
          () => this.connection === connection,
          this.log,
          (ended) => this.onEvent(connection, { event: 'streamEnded', params: ended })
        )
        return
      }
      this.log(hello.failure.message)
      this.connection = null
      connection.kill(hello.failure)
      const { failure } = hello
      if (
        failure.kind === 'unavailable' &&
        (failure.reason === 'tokenMismatch' || failure.reason === 'protocolMismatch')
      ) {
        // Permanent for this build: respawning it would refuse again.
        this.refused = { binary, stamp: simHelperBinaryStamp(binary) }
        this.setState({ state: 'unavailable', failure })
        return
      }
      this.scheduleRestart(failure)
    })
  }

  private resolveBinary(): string | null {
    return this.options.resolveBinary
      ? this.options.resolveBinary()
      : resolveSimHelperBinary({ packaged: this.options.packaged })
  }

  private onEvent(connection: SimHelperConnection, event: SimHelperEvent): void {
    if (this.connection === connection) {
      actOnSimHelperEvent(event, {
        log: this.log,
        recycle: (failure) => connection.kill(failure),
        forgetView: (view) => this.liveViews.ended(view),
        listener: this.options.onEvent
      })
    }
  }

  private onExit(connection: SimHelperConnection, failure: SimHelperFailure): void {
    if (this.connection !== connection) {
      return
    }
    this.connection = null
    this.log(failure.message)
    if (this.readySince && Date.now() - this.readySince >= (this.options.stableAfterMs ?? 60_000)) {
      this.failures = 0
    }
    this.readySince = 0
    this.scheduleRestart(failure)
  }

  private scheduleRestart(failure: SimHelperFailure): void {
    if (this.current.state === 'stopped') {
      return
    }
    this.failures += 1
    const delay = (this.options.restartDelayMs ?? simHelperRestartDelayMs)(this.failures)
    this.setState({
      state: 'restarting',
      failure,
      attempt: this.failures,
      retryAt: Date.now() + delay
    })
    this.restartTimer = setTimeout(() => this.launch(), delay)
    this.restartTimer.unref?.()
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private setState(state: SimHelperState): void {
    this.current = state
    try {
      this.options.onState?.(state)
    } catch (error) {
      // A listener's throw would otherwise leave a restart timer's callback as an uncaught one.
      this.log(`onState threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) {
      wake()
    }
  }
}
