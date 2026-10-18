import { execFile, type ChildProcess } from 'node:child_process'
import { BrowserError } from './cdp-bridge'
import { classifyErrorCode } from './agent-browser-bridge-process'
import { AgentBrowserBridgeExecution } from './agent-browser-bridge-execution'
import { agentBrowserDaemonCommand } from './agent-browser-daemon-command'
import {
  AgentBrowserDaemonCancelled,
  AgentBrowserDaemonTimeout,
  AgentBrowserDaemonUnreachable,
  agentBrowserDaemonEndpoint,
  agentBrowserDaemonSpeaksSupportedProtocol,
  exchangeAgentBrowserDaemonCommand
} from './agent-browser-daemon-socket'
import {
  AGENT_BROWSER_EXIT_DRAIN_MS,
  CONSECUTIVE_TIMEOUT_LIMIT,
  EXEC_TIMEOUT_MS,
  type AgentBrowserExecOptions,
  type SessionState
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeRawProcess extends AgentBrowserBridgeExecution {
  protected abstract destroySession(
    sessionName: string,
    options?: { closeTimeoutMs?: number }
  ): Promise<void>

  protected async runOverDaemonSocket(
    sessionName: string,
    session: SessionState,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string | null> {
    // Why not with env overrides: they configure the CLI process, which this path skips.
    const daemonCommand = execOptions?.envOverrides
      ? null
      : agentBrowserDaemonCommand(commandArgs, execOptions?.stdinText)
    if (!daemonCommand) {
      return null
    }
    session.daemonSocketProtocol ??= agentBrowserDaemonSpeaksSupportedProtocol(
      this.agentBrowserEnv,
      sessionName
    )
    if (!session.daemonSocketProtocol) {
      return null
    }
    const exchange = exchangeAgentBrowserDaemonCommand(
      agentBrowserDaemonEndpoint(this.agentBrowserEnv, sessionName),
      daemonCommand,
      execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS
    )
    session.activeDaemonExchange = exchange
    try {
      const reply = await exchange.reply
      session.consecutiveTimeouts = 0
      return reply
    } catch (error) {
      if (error instanceof AgentBrowserDaemonUnreachable) {
        // The daemon retired itself: the CLI starts the next one against Pod's CDP proxy.
        this.markDaemonReplaced(sessionName, session)
        return null
      }
      if (error instanceof AgentBrowserDaemonCancelled) {
        throw new BrowserError('browser_tab_closed', error.message)
      }
      if (error instanceof AgentBrowserDaemonTimeout) {
        throw this.noteCommandTimeout(sessionName, execOptions)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw this.createCommandError(
        sessionName,
        message,
        classifyErrorCode(message),
        session.webContentsId
      )
    } finally {
      if (session.activeDaemonExchange === exchange) {
        session.activeDaemonExchange = null
      }
    }
  }

  /** The error for a command that outlived its timeout; three in a row retire the session. */
  private noteCommandTimeout(sessionName: string, execOptions?: AgentBrowserExecOptions): Error {
    if (execOptions?.timeoutError) {
      return execOptions.timeoutError
    }
    const liveSession = this.sessions.get(sessionName)
    if (liveSession) {
      liveSession.consecutiveTimeouts++
      if (liveSession.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
        // Why: 3 consecutive timeouts means the daemon is likely stuck — destroy and recreate
        this.destroySession(sessionName)
      }
    }
    return new BrowserError('browser_error', 'Browser command timed out')
  }

  protected runAgentBrowserRaw(
    sessionName: string,
    args: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const session = this.sessions.get(sessionName)
      let child: ChildProcess | null = null
      let exitDrainTimer: ReturnType<typeof setTimeout> | undefined
      child = execFile(
        this.agentBrowserBin,
        args,
        // Why: screenshots return large base64 that exceeds Node's default 1MB maxBuffer (ENOBUFS).
        {
          timeout: execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024,
          // Why windowsHide: see the stale-session close above -- every
          // agent-browser invocation would otherwise flash a console (#14543).
          windowsHide: true,
          env: execOptions?.envOverrides
            ? { ...this.agentBrowserEnv, ...execOptions.envOverrides }
            : this.agentBrowserEnv
        },
        (error, stdout, stderr) => {
          clearTimeout(exitDrainTimer)
          if (session && session.activeProcess === child) {
            session.activeProcess = null
          }
          if (child && this.cancelledProcesses.has(child)) {
            this.cancelledProcesses.delete(child)
            reject(
              new BrowserError('browser_tab_closed', 'Tab was closed while command was running')
            )
            return
          }

          const liveSession = this.sessions.get(sessionName)

          if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(this.noteCommandTimeout(sessionName, execOptions))
            return
          }

          if (liveSession) {
            liveSession.consecutiveTimeouts = 0
          }

          if (error) {
            // Why: agent-browser exits non-zero on failure but still writes structured JSON to stdout — parse it for the real error.
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout)
                if (parsed.error) {
                  const code = classifyErrorCode(parsed.error)
                  reject(
                    this.createCommandError(sessionName, parsed.error, code, session?.webContentsId)
                  )
                  return
                }
              } catch {
                // stdout not valid JSON — fall through to stderr/error.message
              }
            }
            const message = stderr || error.message
            const code = classifyErrorCode(message)
            reject(this.createCommandError(sessionName, message, code, session?.webContentsId))
            return
          }

          resolve(stdout)
        }
      )
      // Why: a Windows daemon inherits the helper's stdio pipes (vercel-labs/agent-browser#1407), so
      // EOF never arrives; after exit, drain briefly then release the pipes so execFile settles.
      child.once('exit', () => {
        exitDrainTimer = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, AGENT_BROWSER_EXIT_DRAIN_MS)
      })
      if (session) {
        session.activeProcess = child
      }
      if (execOptions?.stdinText !== undefined && child?.stdin) {
        // Why: eval --stdin keeps paste-sized scripts out of argv on every platform.
        child.stdin.on('error', () => {})
        child.stdin.end(execOptions.stdinText)
      }
    })
  }
}
