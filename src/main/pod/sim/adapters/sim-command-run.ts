// Fork-only (Pod): one way for the simulator adapters to run a tool (simctl, simslim, ps,
// claude-acc). It always answers: a tool that could not start, ran past its deadline or was killed
// by a signal (the memory brake, a full process table) is an answer too, never a throw and never an
// exit code, so every port built on it keeps its "never throws" promise.
import { runProcess } from '@orca/process-host'

export type SimRunResult =
  | Readonly<{ ok: true; code: number; stdout: string; stderr: string }>
  | Readonly<{ ok: false; reason: 'timeout' | 'spawn' | 'signal'; message: string }>

export type SimRunOptions = Readonly<{ timeoutMs: number; env?: NodeJS.ProcessEnv }>

export type SimRun = (
  program: string,
  args: readonly string[],
  options: SimRunOptions
) => Promise<SimRunResult>

/** Real processes, through process-host (no shell, bounded output, killed at the deadline). */
export const simRunProcess: SimRun = async (program, args, options) => {
  try {
    const result = await runProcess(
      {
        program,
        args,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 32 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {})
      },
      'tail'
    )
    if (result.timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        message: `${program} ${args.join(' ')} ran past ${options.timeoutMs} ms`
      }
    }
    if (result.code === null) {
      return {
        ok: false,
        reason: 'signal',
        message: `${program} was killed by ${result.signal ?? 'a signal'}`
      }
    }
    return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { ok: false, reason: 'spawn', message: `${program}: ${String(error)}` }
  }
}

/** What a failed run says, for an op's failure text (first line of stderr, else stdout). */
export function simRunFailure(what: string, result: SimRunResult): string {
  if (!result.ok) {
    return `${what}: ${result.message}`
  }
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' ')
  return `${what} exited ${result.code}${text ? `: ${text}` : ''}`.slice(0, 1024)
}
