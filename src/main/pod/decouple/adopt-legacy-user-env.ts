// Fork-only (Pod): imported first by the main entry, so modules that read these names when they
// load already see the adopted values (legacy-user-env.ts).
import { adoptLegacyUserEnv } from './legacy-user-env'

const adopted = adoptLegacyUserEnv(process.env)
if (adopted.length > 0) {
  console.log(`[pod-decouple] took the ORCA_ spelling of ${adopted.join(', ')}`)
}
