// Fork-only (Pod): the time each step of a prepare or an open took, in ms, for the caller's report.
export type SimAppHops = Record<string, number>

export type SimHopTimer = Readonly<{
  ms: SimAppHops
  /** Ends the step running since the last hop under `name`. */
  hop(name: string): void
}>

export function simHopTimer(): SimHopTimer {
  const ms: SimAppHops = {}
  let last = performance.now()
  return {
    ms,
    hop(name) {
      const at = performance.now()
      ms[name] = Math.round((at - last) * 100) / 100
      last = at
    }
  }
}
