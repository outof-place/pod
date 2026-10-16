// Fork-only (Pod): the `simulators:` section of a repo's orca.yaml, read-only. It says which apps
// the repo's simulators run and how Pod makes each ready: bundle id, the app's folder, Metro, the
// native fingerprint and build commands, an external dev-client cache to adopt, and the defaults
// written into the app before launch. Runtimes that predate it ignore the key (parseOrcaYaml reads
// only what it knows). A key this Pod does not know is a warning, so newer recipes still run here.
import { z } from 'zod'
import { ORCA_VM_RECIPE_ID_PATTERN, ORCA_VM_RECIPE_ID_RULE } from '../orca-yaml'

export const SIM_RECIPE_APP_ID_PATTERN = ORCA_VM_RECIPE_ID_PATTERN

const Command = z.string().trim().min(1).max(4096)

// Inside the repo: relative, no `..`, no leading `/`; `.` is the repo root.
const RepoPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith('/') && !value.split('/').includes('..'),
    'must be a path inside the repo'
  )

const Metro = z.object({
  port: z.number().int().min(1024).max(65535),
  // `{port}` is replaced with the worktree's own port.
  command: Command.optional()
})

const Build = z.object({
  command: Command,
  // Where the command leaves the simulator .app, relative to the app's path; may hold a `*`.
  output: RepoPath
})

const App = z.object({
  bundleId: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, 'a reverse-DNS bundle id, like eu.portivo.app'),
  scheme: z.string().min(1).max(128).optional(),
  path: RepoPath,
  metro: Metro.optional(),
  // Prints the native fingerprint: @expo/fingerprint's JSON (`hash`) or the bare hash.
  fingerprint: Command.optional(),
  build: Build.optional(),
  // A dev-client cache another tool fills (`<dir>/<fingerprint>.app`); `~` is the home folder.
  clientCache: z.string().trim().min(1).max(1024).optional(),
  // Written into the app's UserDefaults before launch (expo-dev-menu's onboarding keys).
  appDefaults: z
    .record(z.string().min(1).max(256), z.union([z.boolean(), z.number(), z.string()]))
    .optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).optional()
})

const Recipe = z.object({
  // `iphone`, `ipad`, or a model such as `iPhone 16 Pro`.
  device: z.string().trim().min(1).max(128).optional(),
  runtime: z.string().trim().min(1).max(128).optional(),
  // A simslim profile, applied once per pool device and verified.
  slimProfile: RepoPath.optional(),
  default: z.string().optional(),
  apps: z
    .record(z.string(), App)
    .refine((apps) => Object.keys(apps).length > 0, 'needs at least one app')
})

export type SimRecipe = z.infer<typeof Recipe>
export type SimRecipeApp = z.infer<typeof App>

export type SimRecipeDiagnostic = {
  /** The orca.yaml key, from `simulators`: `simulators.apps.mobile.bundleId`. */
  path: string
  severity: 'error' | 'warning'
  message: string
}

const ROOT = 'simulators'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(
  value: unknown,
  known: readonly string[],
  path: string,
  out: SimRecipeDiagnostic[]
): void {
  if (!isRecord(value)) {
    return
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      out.push({
        path: `${path}.${key}`,
        severity: 'warning',
        message: 'not a key this Pod knows; ignored'
      })
    }
  }
}

function warnings(value: unknown): SimRecipeDiagnostic[] {
  const out: SimRecipeDiagnostic[] = []
  if (!isRecord(value)) {
    return out
  }
  if (isRecord(value.apps)) {
    for (const [id, app] of Object.entries(value.apps)) {
      const appPath = `${ROOT}.apps.${id}`
      unknownKeys(app, Object.keys(App.shape), appPath, out)
      if (isRecord(app)) {
        unknownKeys(app.metro, Object.keys(Metro.shape), `${appPath}.metro`, out)
        unknownKeys(app.build, Object.keys(Build.shape), `${appPath}.build`, out)
      }
    }
  }
  unknownKeys(value, Object.keys(Recipe.shape), ROOT, out)
  return out
}

function errors(recipe: SimRecipe): SimRecipeDiagnostic[] {
  const out: SimRecipeDiagnostic[] = []
  for (const id of Object.keys(recipe.apps)) {
    if (!SIM_RECIPE_APP_ID_PATTERN.test(id)) {
      out.push({
        path: `${ROOT}.apps.${id}`,
        severity: 'error',
        message: `Invalid app id. ${ORCA_VM_RECIPE_ID_RULE}`
      })
    }
  }
  if (recipe.default !== undefined && !(recipe.default in recipe.apps)) {
    out.push({ path: `${ROOT}.default`, severity: 'error', message: 'names no app in apps' })
  }
  return out
}

/** The `simulators` value of a parsed orca.yaml: the recipe, or null with what is wrong. */
export function parseSimRecipe(value: unknown): {
  recipe: SimRecipe | null
  diagnostics: SimRecipeDiagnostic[]
} {
  const parsed = Recipe.safeParse(value)
  if (!parsed.success) {
    return {
      recipe: null,
      diagnostics: parsed.error.issues.map((issue) => ({
        path: [ROOT, ...issue.path.map(String)].join('.'),
        severity: 'error',
        message: issue.message
      }))
    }
  }
  const problems = errors(parsed.data)
  return problems.length > 0
    ? { recipe: null, diagnostics: problems }
    : { recipe: parsed.data, diagnostics: warnings(value) }
}
