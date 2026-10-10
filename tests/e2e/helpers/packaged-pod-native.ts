/**
 * Fork-only (Pod): the PodNative a packaged Pod ships in Contents/Helpers, run against that Pod's
 * runtime in the isolated profile. `--background` keeps its window off screen and `--measure`
 * makes it connect, idle, write a report and quit. It runs by path, never through `open`, which
 * could pick any copy registered as codes.pod.native.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type PodNativeReport = {
  connections?: number
  status?: string
  marks?: Record<string, number>
}

export function bundledPodNative(app: string): string | null {
  const executable = path.join(app, 'Contents/Helpers/PodNative.app/Contents/MacOS/PodNative')
  return existsSync(executable) ? executable : null
}

/** The real codes.pod.native preferences, which an isolated run must leave alone. */
export function realPodNativePreferencesMtime(realHome: string): number | null {
  const plist = path.join(realHome, 'Library/Preferences/codes.pod.native.plist')
  return existsSync(plist) ? statSync(plist).mtimeMs : null
}

export async function runBundledPodNative(
  executable: string,
  options: {
    profileDir: string
    home: string
    reportPath: string
    /** Runs once PodNative has connected and is idling, while its processes still exist. */
    whileRunning: () => void
    timeoutMs?: number
  }
): Promise<PodNativeReport> {
  const child = spawn(
    executable,
    [
      '--background',
      '--profile',
      options.profileDir,
      '--measure',
      options.reportPath,
      '--idle-seconds',
      '4',
      '--keys',
      '0',
      '-ApplePersistenceIgnoreState',
      'YES'
    ],
    {
      // Why CFFIXED_USER_HOME: preferences follow it, not HOME, and the user's own PodNative
      // shares codes.pod.native.
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: options.home,
        CFFIXED_USER_HOME: options.home,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        POD_NATIVE_NO_ACC: '1'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code))
  )
  const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000)
  try {
    // MeasurementRun settles for 4 s after connecting, then idles for --idle-seconds.
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    if (child.exitCode !== null) {
      throw new Error(`PodNative exited early (${child.exitCode}): ${stderr.trim()}`)
    }
    options.whileRunning()
    const code = await exited
    if (code !== 0) {
      throw new Error(`PodNative exited ${code}: ${stderr.trim()}`)
    }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
  return parseReport(JSON.parse(readFileSync(options.reportPath, 'utf8')))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReport(value: unknown): PodNativeReport {
  if (!isRecord(value)) {
    throw new Error('PodNative wrote no report object')
  }
  const marks = isRecord(value.marks)
    ? Object.fromEntries(
        Object.entries(value.marks).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    : undefined
  return {
    connections: typeof value.connections === 'number' ? value.connections : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
    marks
  }
}
