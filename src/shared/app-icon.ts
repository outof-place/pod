// Why one option: Pod ships its own icon only. Orca's alternates are Orca marks, and a
// stored 'watercolor' or 'blue' from an imported Orca profile normalizes to it.
export const APP_ICON_OPTIONS = [{ id: 'classic', label: 'Pod' }] as const

export type AppIconId = (typeof APP_ICON_OPTIONS)[number]['id']

export const DEFAULT_APP_ICON_ID: AppIconId = 'classic'

export function normalizeAppIconId(value: unknown): AppIconId {
  return APP_ICON_OPTIONS.some((option) => option.id === value)
    ? (value as AppIconId)
    : DEFAULT_APP_ICON_ID
}
