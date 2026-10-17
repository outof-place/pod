// Fork-only (Pod): the simulator tools, found once per driver. simctl comes from the Xcode that
// `xcrun` picks (DEVELOPER_DIR, else xcode-select), called by its path so each call skips xcrun's
// own lookup; simslim from PATH or the usual install directories (a Pod launched from the Dock has
// a short PATH).
import { resolveExecutableCommand } from '../../../../shared/node-cli-command-resolution'
import type { SimRun } from './sim-command-run'

export type SimTools = Readonly<{ simctl: string | null; simslim: string | null }>

export async function resolveSimTools(run: SimRun): Promise<SimTools> {
  const found = await run('/usr/bin/xcrun', ['-f', 'simctl'], { timeoutMs: 10_000 })
  const simctl = found.ok && found.code === 0 ? found.stdout.trim() || null : null
  return { simctl, simslim: resolveExecutableCommand('simslim') }
}
