// Fork-only (Pod): macOS's first-run assessment of a daemon-host clone, paid off the daemon's start.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { reportDaemonHost } from './daemon-host-darwin-report'
import { runHostTool, type HostToolMode } from './daemon-host-darwin-tools'

const ASSESS_TIMEOUT_MS = 120_000

/** One-app Pod ships pod-assess in the outer app: `<Pod.app>/Contents/MacOS`, beside Helpers. */
export function podAssessPath(runtimeBundleDir: string): string {
  return join(dirname(dirname(runtimeBundleDir)), 'MacOS', 'pod-assess')
}

// Why: a cp -c clone is all new files, and macOS assesses each Mach-O on its first run (~4 s on the
// daemon's first start); pod-assess pays that without running any. No pod-assess: the start pays.
export async function assessDarwinDaemonHost(
  runtimeBundleDir: string,
  cloneBundleDir: string,
  mode: HostToolMode
): Promise<void> {
  const tool = podAssessPath(runtimeBundleDir)
  if (!existsSync(tool)) {
    return
  }
  const startedAt = Date.now()
  const result = await runHostTool(tool, ['--bundle', cloneBundleDir], ASSESS_TIMEOUT_MS, {
    background: true,
    ...(mode.signal ? { signal: mode.signal } : {})
  })
  if (result.code === 0) {
    reportDaemonHost('assessed', `assessed ${cloneBundleDir} in ${Date.now() - startedAt} ms`)
  } else {
    reportDaemonHost(
      'unassessed',
      `pod-assess exited ${result.code ?? result.signal} for ${cloneBundleDir}; the daemon's first start from it pays the assessment`
    )
  }
}
