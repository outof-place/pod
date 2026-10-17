// Fork-only (Pod): the recipe app a worktree asks for, on this Mac only. A worktree on an SSH host
// is refused, never guessed at (simulators and dev-client builds run where Pod runs); a folder
// workspace works as a worktree does when it has a recipe. An app folder with a `.env.example` and
// no .env file Expo loads (@expo/env 2.5.1: `.env.development.local`, `.env.local`,
// `.env.development`, `.env`) is refused naming the file and the command that makes it: without it
// the app runs to React Native's error screen while Metro says it connected.
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { SimRecipeApp, SimRecipeDiagnostic } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'
import type { SimPodHomeClaim } from '../adapters/sim-pod-home'
import { pickSimApp, readSimAppRecipe } from './sim-app-recipes'

export type SimAppPrepareInput = Readonly<{
  worktreeRoot: string
  app?: string
  // The worktree's SSH host, when it has one: simulators and builds run on this Mac only.
  remoteHost?: string
}>

export type SimAppRefused = Readonly<{ ok: false; refusal: SimRefusalInput }>

export type SimAppResolved =
  | Readonly<{ ok: true; id: string; app: SimRecipeApp; warnings: readonly SimRecipeDiagnostic[] }>
  | SimAppRefused

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

/** A path as one shell word. */
function shellWord(path: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

/** The package manager's `env:pull` in `dir`, by the lockfile there or at the worktree root. */
async function runScript(dir: string, worktreeRoot: string): Promise<string> {
  const at = shellWord(dir)
  for (const root of [dir, worktreeRoot]) {
    if (await exists(join(root, 'pnpm-lock.yaml'))) {
      return `pnpm -C ${at} env:pull`
    }
    if (await exists(join(root, 'yarn.lock'))) {
      return `yarn --cwd ${at} env:pull`
    }
  }
  return `npm --prefix ${at} run env:pull`
}

/** An `env:pull` script from the app folder up to the worktree root, as a command to run. */
async function envPullCommand(worktreeRoot: string, appDir: string): Promise<string | null> {
  for (let dir = appDir; ; dir = dirname(dir)) {
    const manifest: unknown = await readFile(join(dir, 'package.json'), 'utf8').then(
      (text) => JSON.parse(text),
      () => null
    )
    const scripts =
      manifest && typeof manifest === 'object' && 'scripts' in manifest ? manifest.scripts : null
    if (scripts && typeof scripts === 'object' && Object.hasOwn(scripts, 'env:pull')) {
      return runScript(dir, worktreeRoot)
    }
    if (
      dir === worktreeRoot ||
      dir === dirname(dir) ||
      relative(worktreeRoot, dir).startsWith('..')
    ) {
      return null
    }
  }
}

/** The refusal for an app folder whose .env is missing, when its `.env.example` says it needs one. */
async function missingEnv(
  worktreeRoot: string,
  id: string,
  appDir: string
): Promise<SimAppRefused | null> {
  const example = join(appDir, '.env.example')
  if (!(await exists(example))) {
    return null
  }
  const present = await Promise.all(ENV_FILES.map((name) => exists(join(appDir, name))))
  if (present.some(Boolean)) {
    return null
  }
  const file = join(appDir, '.env')
  const command =
    (await envPullCommand(worktreeRoot, appDir).catch(() => null)) ??
    `cp ${shellWord(example)} ${shellWord(file)}`
  return {
    ok: false,
    refusal: {
      code: 'unavailable',
      problem:
        `${file} is missing: the ${id} app reads its settings from it (${example} lists them) and stops at an error screen without it. Make it before you lease again.`.slice(
          0,
          1024
        ),
      missing: { file, command: command.slice(0, 1024) }
    }
  }
}

export function simAppUnavailable(problem: string): SimAppRefused {
  return { ok: false, refusal: { code: 'unavailable', problem: problem.slice(0, 1024) } }
}

export async function resolveSimApp(
  input: SimAppPrepareInput,
  options: Readonly<{ claim: () => Promise<SimPodHomeClaim>; recipesFile: string }>
): Promise<SimAppResolved> {
  if (input.remoteHost) {
    return simAppUnavailable(
      `simulators and dev-client builds run on the Mac that runs Pod; ${input.worktreeRoot} is on ${input.remoteHost}.`
    )
  }
  const claimed = await options.claim()
  if (!claimed.ok) {
    return simAppUnavailable(claimed.message)
  }
  if (!(await stat(input.worktreeRoot).catch(() => null))?.isDirectory()) {
    return simAppUnavailable(`${input.worktreeRoot} is not a folder on this Mac.`)
  }
  const recipe = await readSimAppRecipe(input.worktreeRoot, { overrideFile: options.recipesFile })
  if (!recipe.ok) {
    return recipe
  }
  const picked = pickSimApp(recipe.recipe, input.app)
  if (!picked.ok) {
    return picked
  }
  const unset = await missingEnv(
    input.worktreeRoot,
    picked.id,
    join(input.worktreeRoot, picked.app.path)
  )
  return unset ?? { ...picked, warnings: recipe.warnings }
}
