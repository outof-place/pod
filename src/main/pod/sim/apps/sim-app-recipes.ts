// Fork-only (Pod): which simulators recipe a worktree has. In order: the local override in the
// simulator home (`recipes.yaml`, keyed by the repo's main checkout so every worktree of a repo
// shares it, or by a folder workspace's own path), then the worktree's pod.yaml, then its orca.yaml;
// the first that has a `simulators:` section is the recipe, whole (no merging). A file that is not
// YAML, or a section that is not a valid recipe, is refused naming the file and the key, never
// skipped for the next one. Marcel's team renames Orca names to Pod before 1.0, so pod.yaml wins.
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import {
  MAX_ORCA_YAML_ALIAS_COUNT,
  isOrcaYamlTextWithinLimit
} from '../../../../shared/orca-yaml-file-limit'
import { isOrcaYamlConversionWithinLimit } from '../../../../shared/orca-yaml-merge-expansion'
import {
  parseSimRecipe,
  type SimRecipe,
  type SimRecipeApp,
  type SimRecipeDiagnostic
} from '../../../../shared/pod-sim/sim-recipe'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'

export const SIM_RECIPE_FILES = ['pod.yaml', 'orca.yaml'] as const

export type SimRecipeRead =
  | Readonly<{
      ok: true
      recipe: SimRecipe
      // The file it came from, as a refusal names it.
      file: string
      warnings: readonly SimRecipeDiagnostic[]
    }>
  | Readonly<{
      ok: false
      refusal: Extract<SimRefusalInput, { code: 'no_recipe' | 'bad_recipe' }>
    }>

export type SimAppPick =
  | Readonly<{ ok: true; id: string; app: SimRecipeApp }>
  | Readonly<{
      ok: false
      refusal: Extract<SimRefusalInput, { code: 'unknown_app' | 'ambiguous_app' }>
    }>

type Parsed = { ok: true; root: unknown } | { ok: false; problem: string }

/** The YAML document as JS, with orca.yaml's size and alias limits. */
function parseYaml(content: string): Parsed {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return { ok: false, problem: 'the file is larger than Pod reads (256 KB)' }
  }
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      merge: true,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0) {
      return { ok: false, problem: `not valid YAML (${document.errors[0].message.split('\n')[0]})` }
    }
    if (!isOrcaYamlConversionWithinLimit(document)) {
      return { ok: false, problem: 'its aliases expand past what Pod reads' }
    }
    return { ok: true, root: document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT }) }
  } catch (error) {
    return { ok: false, problem: `not valid YAML (${String(error).split('\n')[0]})` }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function textOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function fromSection(section: unknown, file: string): SimRecipeRead {
  const parsed = parseSimRecipe(section)
  if (!parsed.recipe) {
    const first = parsed.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    return {
      ok: false,
      refusal: {
        code: 'bad_recipe',
        file,
        path: (first?.path ?? 'simulators').slice(0, 1024),
        problem: (first?.message ?? 'not a recipe').slice(0, 1024)
      }
    }
  }
  return { ok: true, recipe: parsed.recipe, file, warnings: parsed.diagnostics }
}

/**
 * The repo a worktree belongs to, as the override keys it: the main checkout of a git worktree
 * (from its `.git` file's gitdir and that dir's commondir, no git process), the root itself for a
 * main checkout or a folder workspace.
 */
export async function simRepoKey(worktreeRoot: string): Promise<string> {
  const dotGit = join(worktreeRoot, '.git')
  const info = await stat(dotGit).catch(() => null)
  if (!info?.isFile()) {
    return worktreeRoot
  }
  const pointer = /^gitdir:\s*(.+)$/m.exec((await textOrNull(dotGit)) ?? '')
  if (!pointer) {
    return worktreeRoot
  }
  const gitDir = resolve(worktreeRoot, pointer[1].trim())
  const common = (await textOrNull(join(gitDir, 'commondir')))?.trim()
  if (!common) {
    return worktreeRoot
  }
  const commonDir = isAbsolute(common) ? common : resolve(gitDir, common)
  return commonDir.endsWith('/.git') ? dirname(commonDir) : commonDir
}

/** Whether `worktreeRoot` is its repo's main checkout (or a folder workspace). */
export async function simIsMainCheckout(worktreeRoot: string): Promise<boolean> {
  return (await simRepoKey(worktreeRoot)) === worktreeRoot
}

export type SimRecipeSourceOptions = Readonly<{
  // `recipes.yaml` in the simulator home.
  overrideFile: string
}>

/** The recipe a worktree runs, or why it has none it can use. */
export async function readSimAppRecipe(
  worktreeRoot: string,
  options: SimRecipeSourceOptions
): Promise<SimRecipeRead> {
  const overrideText = await textOrNull(options.overrideFile)
  if (overrideText !== null) {
    const parsed = parseYaml(overrideText)
    if (!parsed.ok) {
      return {
        ok: false,
        refusal: {
          code: 'bad_recipe',
          file: options.overrideFile,
          path: 'simulators',
          problem: parsed.problem
        }
      }
    }
    const key = await simRepoKey(worktreeRoot)
    if (isRecord(parsed.root) && Object.hasOwn(parsed.root, key)) {
      return fromSection(parsed.root[key], `${options.overrideFile} (${key})`)
    }
  }
  for (const name of SIM_RECIPE_FILES) {
    const file = join(worktreeRoot, name)
    const text = await textOrNull(file)
    if (text === null) {
      continue
    }
    const parsed = parseYaml(text)
    if (!parsed.ok) {
      return {
        ok: false,
        refusal: { code: 'bad_recipe', file, path: 'simulators', problem: parsed.problem }
      }
    }
    if (isRecord(parsed.root) && Object.hasOwn(parsed.root, 'simulators')) {
      return fromSection(parsed.root.simulators, file)
    }
  }
  return {
    ok: false,
    refusal: { code: 'no_recipe', worktreeRoot, files: [...SIM_RECIPE_FILES] }
  }
}

/** The app a call names, else the recipe's default, else its only app. */
export function pickSimApp(recipe: SimRecipe, asked?: string): SimAppPick {
  const ids = Object.keys(recipe.apps)
  const id = asked ?? recipe.default ?? (ids.length === 1 ? ids[0] : undefined)
  if (id === undefined) {
    return { ok: false, refusal: { code: 'ambiguous_app', apps: ids } }
  }
  // Own keys only: `constructor` or `__proto__` is no app of the recipe's.
  return Object.hasOwn(recipe.apps, id)
    ? { ok: true, id, app: recipe.apps[id] }
    : { ok: false, refusal: { code: 'unknown_app', app: id.slice(0, 1024), apps: ids } }
}
