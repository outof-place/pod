import { statSync, statfsSync } from 'node:fs'
import { runProcess } from '@orca/process-host'

const TOOL_TIMEOUT_MS = 5_000

/**
 * Whether `cp -c` can clone `source` into `targetDir`: one volume, and APFS. `cp -c` falls back to
 * a byte copy silently, and Node cannot ask (libuv answers COPYFILE_FICLONE_FORCE with ENOSYS on
 * macOS), so the volume's type comes from mount(8) for the device stat(1) names.
 */
export async function volumeCanClone(source: string, targetDir: string): Promise<boolean> {
  try {
    if (statSync(source).dev !== statSync(targetDir).dev) {
      return false
    }
    const device = await runProcess({
      program: '/usr/bin/stat',
      args: ['-f', '%Sd', targetDir],
      timeoutMs: TOOL_TIMEOUT_MS
    })
    const name = device.stdout.trim()
    if (device.code !== 0 || !/^disk[0-9s]+$/.test(name)) {
      return false
    }
    const mounts = await runProcess({ program: '/sbin/mount', timeoutMs: TOOL_TIMEOUT_MS })
    return mounts.stdout
      .split('\n')
      .some((line) => line.startsWith(`/dev/${name} on `) && /\(apfs[,)]/.test(line))
  } catch {
    return false
  }
}

/** Bytes an unprivileged writer may still use on the volume holding `dir`. */
export function freeBytes(dir: string): number {
  const { bavail, bsize } = statfsSync(dir)
  return Number(bavail) * Number(bsize)
}
