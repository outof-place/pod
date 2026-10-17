// Fork-only (Pod): the pod-sim helper's self-test in the frozen contract's words (owed to stage 4
// by stage 2a): `hid` is `input`, `ax` is `accessibility`, a `failed` check is `unsupported`, and
// whatever works on a build the version table does not know is `unverified`. Settled is a stable
// accessibility tree plus a quiet display, so it is as good as the weaker of the two; nothing
// records yet.
import type { z } from 'zod'
import type { SimHelperStatus } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimHelperReport } from '../helper/sim-helper-protocol'

type Status = z.infer<typeof SimHelperStatus>
type Capability = Status['capabilities']['display']

const RANK: Readonly<Record<Capability, number>> = { ok: 2, unverified: 1, unsupported: 0 }

function weaker(a: Capability, b: Capability): Capability {
  return RANK[a] <= RANK[b] ? a : b
}

const UNSUPPORTED: Status['capabilities'] = {
  display: 'unsupported',
  screenshot: 'unsupported',
  input: 'unsupported',
  accessibility: 'unsupported',
  settle: 'unsupported',
  record: 'unsupported'
}

export function simHelperStatusOf(report: SimHelperReport | null): Status {
  if (!report) {
    return { state: 'absent', capabilities: UNSUPPORTED }
  }
  const known = report.table.known && !report.problem
  const verdict = (check: { status: string }): Capability =>
    check.status !== 'ok' ? 'unsupported' : known ? 'ok' : 'unverified'
  const { display, screenshot, hid, ax } = report.capabilities
  const capabilities: Status['capabilities'] = {
    display: verdict(display),
    screenshot: verdict(screenshot),
    input: verdict(hid),
    accessibility: verdict(ax),
    settle: weaker(verdict(ax), verdict(display)),
    record: 'unsupported'
  }
  const anything = Object.values(capabilities).some((capability) => capability !== 'unsupported')
  const state = report.problem || !anything ? 'unsupported' : known ? 'ok' : 'unverified'
  const versions = {
    ...(report.xcode?.build ? { xcodeBuild: report.xcode.build.slice(0, 64) } : {}),
    ...(report.coreSimulator ? { coreSimulator: report.coreSimulator.version.slice(0, 64) } : {}),
    ...(report.simulatorKit ? { simulatorKit: report.simulatorKit.version.slice(0, 64) } : {})
  }
  return { state, ...versions, capabilities }
}
