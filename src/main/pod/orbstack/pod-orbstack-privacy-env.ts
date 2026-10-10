// Fork-only (Pod): the Mac's Claude Code privacy and traffic switches, mirrored into a sandbox so a
// sandboxed agent sends nothing the Mac agent would not.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** From code.claude.com/docs/en/env-vars and data-usage. */
export const MIRRORED_PRIVACY_ENV = [
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
  'DISABLE_BUG_COMMAND',
  'DISABLE_NON_ESSENTIAL_MODEL_CALLS',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
  'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'
] as const

const MAC_MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json'

export type SandboxPrivacy = {
  /** Set in the VM exactly as on the Mac. */
  env: Record<string, string>
  /** Usage metrics are off on the Mac, so the route refuses event logging. */
  telemetryOff: boolean
  /** Feature-flag fetching is off on the Mac, so the route refuses /api/eval. */
  featureFlagsOff: boolean
}

function settingsEnv(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const env = typeof parsed === 'object' && parsed !== null && 'env' in parsed ? parsed.env : null
    return typeof env === 'object' && env !== null ? { ...env } : {}
  } catch {
    return {}
  }
}

const isOn = (value: string | undefined) =>
  value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())

/** Reads the process env, then the user's and the managed settings' `env` blocks; any one counts. */
export function readMacClaudePrivacy(
  args: { env?: NodeJS.ProcessEnv; settingsFiles?: readonly string[] } = {}
): SandboxPrivacy {
  const env = args.env ?? process.env
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const files = args.settingsFiles ?? [join(configDir, 'settings.json'), MAC_MANAGED_SETTINGS]
  const sources = [env, ...files.map(settingsEnv)]
  const mirrored: Record<string, string> = {}
  for (const name of MIRRORED_PRIVACY_ENV) {
    const value = sources
      .map((source) => source[name])
      .find((v) => typeof v === 'string' && v !== '')
    if (typeof value === 'string') {
      mirrored[name] = value
    }
  }
  // Any non-empty value turns nonessential traffic off, "0" and "false" included.
  const nonessentialOff = mirrored.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined
  const telemetryOff =
    nonessentialOff || isOn(mirrored.DISABLE_TELEMETRY) || isOn(mirrored.DO_NOT_TRACK)
  return {
    env: mirrored,
    telemetryOff,
    featureFlagsOff:
      nonessentialOff || isOn(mirrored.DISABLE_TELEMETRY) || isOn(mirrored.DISABLE_GROWTHBOOK)
  }
}

export const OPEN_PRIVACY: SandboxPrivacy = { env: {}, telemetryOff: false, featureFlagsOff: false }
