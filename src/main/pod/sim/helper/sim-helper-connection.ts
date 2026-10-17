// Fork-only (Pod): one spawned pod-sim process: hello with this spawn's token, id-matched calls
// with deadlines, and one report when the process is gone. Restarting is the supervisor's job.
import type { Readable, Writable } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import { parseSimHelperEvent, type SimHelperEvent } from './sim-helper-events'
import {
  SIM_HELPER_MAX_FRAME_BYTES,
  SIM_HELPER_PROTOCOL_VERSION,
  SIM_HELPER_TOKEN_ENV,
  SimHelperReplyFrame,
  SimHelperReport
} from './sim-helper-protocol'
import {
  simHelperFailed,
  simHelperUnavailable,
  type SimHelperFailure,
  type SimHelperResult
} from './sim-helper-result'

/** The part of a spawned child this client uses; `spawnProcess`'s piped child is one. */
export type SimHelperChild = {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'exit', listener: () => void): unknown
}

export type SimHelperSpawner = (spec: PipedProcessSpec) => SimHelperChild

export type SimHelperConnectionOptions = {
  binary: string
  /** The helper's whole environment; the token is added here. */
  env: NodeJS.ProcessEnv
  token: string
  spawn?: SimHelperSpawner
  log: (message: string) => void
  /** Once, on a later tick, when the process is gone for any reason (never inside the constructor). */
  onExit: (failure: SimHelperFailure) => void
  /** Each known event line the helper sends unasked; unknown ones are logged and dropped. */
  onEvent?: (event: SimHelperEvent) => void
}

type Pending = {
  resolve: (result: SimHelperResult<Record<string, unknown>>) => void
  timer: NodeJS.Timeout
}

export class SimHelperConnection {
  private readonly child: SimHelperChild | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 0
  private stdoutBuffer = ''
  private exited: SimHelperFailure | null = null
  // Why the supervisor ended it (a missed deadline), so the exit reports that, not a crash.
  private killedFor: SimHelperFailure | null = null

  constructor(private readonly options: SimHelperConnectionOptions) {
    const spec: PipedProcessSpec = {
      program: options.binary,
      args: [],
      env: { ...options.env, [SIM_HELPER_TOKEN_ENV]: options.token },
      stdio: 'pipe'
    }
    try {
      this.child = (options.spawn ?? spawnProcess)(spec)
    } catch (error) {
      this.exit(simHelperUnavailable('spawnFailed', describeError(error)))
      return
    }
    const child = this.child
    child.on('error', (error) =>
      this.exit(simHelperUnavailable('spawnFailed', describeError(error)))
    )
    child.on('exit', (code, signal) =>
      this.exit(
        this.killedFor ??
          simHelperUnavailable(
            'crashed',
            signal ? `killed by ${signal}` : `exited with code ${code}`
          )
      )
    )
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter((part) => part.trim() !== '')) {
        options.log(`[pod-sim ${child.pid ?? '?'}] ${line.slice(0, 500)}`)
      }
    })
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get gone(): boolean {
    return this.exited !== null
  }

  /** The handshake: proves the process is this spawn's pod-sim and speaks protocol v1. */
  async hello(timeoutMs: number): Promise<SimHelperResult<SimHelperReport>> {
    const reply = await this.call(
      'hello',
      { token: this.options.token, protocol: SIM_HELPER_PROTOCOL_VERSION },
      timeoutMs
    )
    if (!reply.ok) {
      const { failure } = reply
      if (failure.kind === 'error' && failure.code === 'tokenMismatch') {
        return simHelperFailed(simHelperUnavailable('tokenMismatch', failure.message))
      }
      if (failure.kind === 'error' && failure.code === 'protocolMismatch') {
        return simHelperFailed(simHelperUnavailable('protocolMismatch', failure.message))
      }
      return failure.kind === 'error'
        ? simHelperFailed(simHelperUnavailable('badHello', `${failure.code}: ${failure.message}`))
        : reply
    }
    const report = SimHelperReport.safeParse(reply.value)
    if (!report.success) {
      return simHelperFailed(simHelperUnavailable('badHello', 'hello answered an unknown shape'))
    }
    if (report.data.protocol !== SIM_HELPER_PROTOCOL_VERSION) {
      return simHelperFailed(
        simHelperUnavailable('protocolMismatch', `helper speaks ${report.data.protocol}`)
      )
    }
    return { ok: true, value: report.data }
  }

  call(
    method: string,
    params: object,
    timeoutMs: number
  ): Promise<SimHelperResult<Record<string, unknown>>> {
    if (this.exited !== null || !this.child) {
      return Promise.resolve(simHelperFailed(this.exited ?? simHelperUnavailable('crashed')))
    }
    const id = ++this.nextId
    const line = `${JSON.stringify({ id, method, params })}\n`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(simHelperFailed(simHelperUnavailable('timeout', `${method} after ${timeoutMs} ms`)))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.child?.stdin.write(line)
    })
  }

  /** SIGKILL; `reason` is what its exit and every call still in flight report. */
  kill(reason?: SimHelperFailure): void {
    if (this.exited === null) {
      this.killedFor ??= reason ?? null
      this.child?.kill('SIGKILL')
    }
  }

  /** Ends stdin (the helper detaches its displays and exits 0), then SIGKILL after the grace. */
  async close(graceMs: number): Promise<void> {
    if (this.exited !== null || !this.child) {
      return
    }
    const child = this.child
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, graceMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      this.onFrame(this.stdoutBuffer.slice(0, newline))
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      newline = this.stdoutBuffer.indexOf('\n')
    }
    // The helper's frames are bounded too; past the bound this is not pod-sim speaking.
    if (this.stdoutBuffer.length > SIM_HELPER_MAX_FRAME_BYTES) {
      this.options.log('[pod-sim] dropped an oversized line on stdout')
      this.stdoutBuffer = ''
    }
  }

  private onFrame(line: string): void {
    if (line.trim() === '') {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.options.log(`[pod-sim] ignored a line that is not JSON: ${line.slice(0, 200)}`)
      return
    }
    if (typeof parsed === 'object' && parsed !== null && 'event' in parsed && !('id' in parsed)) {
      const event = parseSimHelperEvent(parsed)
      if (event.ok) {
        this.options.onEvent?.(event.event)
      } else {
        this.options.log(`[pod-sim] ignored ${event.reason}: ${line.slice(0, 200)}`)
      }
      return
    }
    const frame = SimHelperReplyFrame.safeParse(parsed)
    if (!frame.success || frame.data.id === null) {
      this.options.log(`[pod-sim] ignored a frame: ${line.slice(0, 200)}`)
      return
    }
    const waiter = this.pending.get(frame.data.id)
    if (!waiter) {
      return
    }
    this.pending.delete(frame.data.id)
    clearTimeout(waiter.timer)
    waiter.resolve(
      'result' in frame.data
        ? { ok: true, value: frame.data.result }
        : simHelperFailed({ kind: 'error', ...frame.data.error })
    )
  }

  private exit(failure: SimHelperFailure): void {
    if (this.exited !== null) {
      return
    }
    this.exited = failure
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve(simHelperFailed(failure))
    }
    // Deferred: a spawn that throws reaches here inside the constructor, before the owner has it.
    queueMicrotask(() => this.options.onExit(failure))
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' && !error.message.includes(code)
    ? `${code}: ${error.message}`
    : error.message
}
