// Fork-only (Pod): the recipe app a worktree asks for, on this Mac only. A worktree on an SSH host
// is refused, never guessed at (simulators and dev-client builds run where Pod runs); a folder
// workspace works as a worktree does when it has a recipe.
import { stat } from 'node:fs/promises'
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
  return picked.ok ? { ...picked, warnings: recipe.warnings } : picked
}
