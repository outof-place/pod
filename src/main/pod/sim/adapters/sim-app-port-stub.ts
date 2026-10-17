// Fork-only (Pod): the pool's app port until stage 5's app module fills it. `reset app` and the
// reinstall after `reset device` need the lease's dev client (recipe, fingerprint, Mac-wide
// cache), which only stage 5 knows; until then both resolve at once and install nothing.
import type { SimAppPort } from '../pool/sim-pool-ports'

export const simAppPortStub: SimAppPort = {
  reset: async () => undefined,
  reinstall: async () => undefined
}
