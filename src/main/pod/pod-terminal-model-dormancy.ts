import type { GlobalSettings } from '../../shared/global-settings-types'

type DormancySettings = Partial<
  Pick<GlobalSettings, 'terminalMainModelDormancy' | 'podTerminalMainModelDormancy'>
>

/**
 * Fork-only (Pod): whether main's terminal model may go dormant. Pod's own key wins, and Pod
 * builds default it off: rebuilt models lose history and relax agent readiness on a failed seed.
 * Why not Orca's key: earlier Pod builds stored its old default `true`, which has no UI to change.
 * Orca builds never set Pod's key and keep Orca's kill switch.
 */
export function isMainTerminalModelDormancyEnabled(
  settings: DormancySettings | undefined
): boolean {
  return settings?.podTerminalMainModelDormancy ?? settings?.terminalMainModelDormancy !== false
}
