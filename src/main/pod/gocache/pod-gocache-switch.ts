import type { GlobalSettings } from '../../../shared/global-settings-types'

/**
 * The two ways to turn pod-gocache off: `POD_GOCACHE=0` (or `off`) in Pod's own environment, and
 * the podGoCacheEnabled setting, on unless the user turned it off. Either stops installs and
 * GOCACHEPROG for new terminals; neither removes an installed agent.
 */
export const POD_GOCACHE_ENV = 'POD_GOCACHE'
// Dev opt-in for terminal GOCACHEPROG until Pod routes go's subcommands itself.
export const POD_GOCACHE_TERMINAL_ENV = 'POD_GOCACHE_TERMINAL_ENV'

export function isPodGoCacheOff(mode: string | undefined): boolean {
  return mode === 'off' || mode === '0'
}

export function isPodGoCacheTerminalEnvOptedIn(env: NodeJS.ProcessEnv): boolean {
  return env[POD_GOCACHE_TERMINAL_ENV] === '1'
}

export function isPodGoCacheSettingOn(
  settings: Pick<GlobalSettings, 'podGoCacheEnabled'>
): boolean {
  return settings.podGoCacheEnabled !== false
}
