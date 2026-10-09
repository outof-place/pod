// Fork-only (Pod): carries a product's "stablyServices": false into hosts that cannot read the
// app's identity file: orcad runs on bundled Node, locally under `podx serve` or on an SSH host.
export const STABLY_SERVICES_OFF_ENV = 'POD_STABLY_SERVICES_OFF'

export function isStablyServicesOffByEnv(env: NodeJS.ProcessEnv): boolean {
  return env[STABLY_SERVICES_OFF_ENV] === '1'
}

/** Launch environment for an orcad started by a host whose services flag is `stablyServices`. */
export function stablyServicesLaunchEnv(stablyServices: boolean): [string, string][] {
  return stablyServices ? [] : [[STABLY_SERVICES_OFF_ENV, '1']]
}
