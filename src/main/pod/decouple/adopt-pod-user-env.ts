// Fork-only (Pod): imported first by the main entry, so modules that read a user setting when they
// load already see its POD_ value under the ORCA_ name (pod-env-aliases.ts, mode 'start').
import { applyPodEnvAliases } from '../../../shared/pod-env-aliases'

const adopted = applyPodEnvAliases(process.env, { mode: 'start' })
if (adopted.length > 0) {
  console.log(`[pod-env] took the POD_ spelling of ${adopted.join(', ')}`)
}
