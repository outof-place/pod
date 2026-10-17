import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSimRecipe } from '../../../../shared/pod-sim/sim-recipe'
import { simRefusal } from '../../../../shared/pod-sim/sim-refusals'
import { pickSimApp, readSimAppRecipe, simIsMainCheckout, simRepoKey } from './sim-app-recipes'
import { recipeYaml, sandbox, worktree, type Sandbox } from './sim-app.test-support'

let box: Sandbox
let overrideFile: string

beforeEach(async () => {
  box = await sandbox()
  overrideFile = join(box.dir, 'recipes.yaml')
})

afterEach(async () => {
  await box.cleanup()
})

describe('which recipe a worktree runs', () => {
  it('reads orca.yaml, and pod.yaml over it when both have one', async () => {
    const root = await worktree(box, 'wt-a', { file: 'orca.yaml' })
    const fromOrca = await readSimAppRecipe(root, { overrideFile })
    expect(fromOrca.ok && fromOrca.file).toBe(join(root, 'orca.yaml'))

    await writeFile(
      join(root, 'pod.yaml'),
      recipeYaml({ app: 'metro:\n  port: 9090' }).replace(
        'com.example.podsim',
        'com.example.fromPod'
      )
    )
    const fromPod = await readSimAppRecipe(root, { overrideFile })
    expect(fromPod.ok && fromPod.file).toBe(join(root, 'pod.yaml'))
    expect(fromPod.ok && fromPod.recipe.apps.app.bundleId).toBe('com.example.fromPod')
  })

  it('falls back to orca.yaml when pod.yaml has no simulators section', async () => {
    const root = await worktree(box, 'wt-b', { file: 'orca.yaml' })
    await writeFile(join(root, 'pod.yaml'), 'scripts:\n  setup: pnpm install\n')
    const read = await readSimAppRecipe(root, { overrideFile })
    expect(read.ok && read.file).toBe(join(root, 'orca.yaml'))
  })

  it('takes the local override for every worktree of its repo, over the repo’s files', async () => {
    const main = await worktree(box, null, { file: 'pod.yaml' })
    const other = await worktree(box, 'wt-c', { file: 'pod.yaml' })
    const entry = recipeYaml({ app: 'metro:\n  port: 9191' })
      .replace('simulators:\n', '')
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    await writeFile(overrideFile, `${JSON.stringify(box.repo)}:\n${entry}\n`)
    for (const root of [main, other]) {
      const read = await readSimAppRecipe(root, { overrideFile })
      expect(read.ok && read.file).toBe(`${overrideFile} (${box.repo})`)
      expect(read.ok && read.recipe.apps.app.metro?.port).toBe(9191)
    }
  })

  it('refuses a bad recipe naming its file and key, never skipping to the next file', async () => {
    const root = await worktree(box, 'wt-d', { file: 'orca.yaml' })
    await writeFile(join(root, 'pod.yaml'), recipeYaml({ app: 'metro:\n  port: 80' }))
    const read = await readSimAppRecipe(root, { overrideFile })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.refusal).toMatchObject({
        code: 'bad_recipe',
        file: join(root, 'pod.yaml'),
        path: 'simulators.apps.app.metro.port'
      })
      expect(simRefusal(read.refusal).message).toContain(
        `${join(root, 'pod.yaml')} simulators.apps.app.metro.port:`
      )
    }
  })

  it('names a missing bundle id in the override with the override file and its repo', async () => {
    const root = await worktree(box, 'wt-e', null)
    await writeFile(
      overrideFile,
      `${JSON.stringify(box.repo)}:\n  apps:\n    app:\n      path: apps/app\n`
    )
    const read = await readSimAppRecipe(root, { overrideFile })
    expect(!read.ok && read.refusal).toMatchObject({
      code: 'bad_recipe',
      file: `${overrideFile} (${box.repo})`,
      path: 'simulators.apps.app.bundleId'
    })
  })

  it('refuses YAML that does not parse, naming the file', async () => {
    const root = await worktree(box, 'wt-f', null)
    await writeFile(join(root, 'orca.yaml'), 'simulators: [unclosed\n')
    const read = await readSimAppRecipe(root, { overrideFile })
    expect(!read.ok && read.refusal).toMatchObject({
      code: 'bad_recipe',
      file: join(root, 'orca.yaml')
    })
  })

  it('says where it looked when a worktree or folder workspace has no recipe', async () => {
    const folder = join(box.dir, 'folder-workspace')
    await mkdir(folder, { recursive: true })
    const read = await readSimAppRecipe(folder, { overrideFile })
    expect(!read.ok && read.refusal).toEqual({
      code: 'no_recipe',
      worktreeRoot: folder,
      files: ['pod.yaml', 'orca.yaml']
    })
    if (!read.ok) {
      expect(simRefusal(read.refusal).message).toBe(
        `No simulators recipe in ${folder}/pod.yaml or ${folder}/orca.yaml; add a simulators: section first. Run: podx sim lease`
      )
    }
  })
})

describe('the repo a worktree belongs to', () => {
  it('is the main checkout for a linked worktree, the root itself otherwise', async () => {
    const main = await worktree(box, null, null)
    const linked = await worktree(box, 'wt-g', null)
    const folder = join(box.dir, 'plain')
    await mkdir(folder)
    expect(await simRepoKey(linked)).toBe(box.repo)
    expect(await simRepoKey(main)).toBe(main)
    expect(await simRepoKey(folder)).toBe(folder)
    expect(await simIsMainCheckout(main)).toBe(true)
    expect(await simIsMainCheckout(linked)).toBe(false)
  })
})

describe('which app a call means', () => {
  const recipe = {
    apps: {
      mobile: { bundleId: 'eu.portivo.app', path: 'apps/mobile' },
      operator: { bundleId: 'eu.portivo.operator', path: 'apps/charter-mobile' }
    }
  }

  it('is the one named, else the default, else the only one', () => {
    expect(pickSimApp(recipe, 'operator')).toMatchObject({ ok: true, id: 'operator' })
    expect(pickSimApp({ ...recipe, default: 'mobile' })).toMatchObject({ ok: true, id: 'mobile' })
    expect(pickSimApp({ apps: { solo: recipe.apps.mobile } })).toMatchObject({
      ok: true,
      id: 'solo'
    })
  })

  it('asks which one when several and none is the default, and lists them for an unknown one', () => {
    expect(pickSimApp(recipe)).toEqual({
      ok: false,
      refusal: { code: 'ambiguous_app', apps: ['mobile', 'operator'] }
    })
    expect(pickSimApp(recipe, 'web')).toEqual({
      ok: false,
      refusal: { code: 'unknown_app', app: 'web', apps: ['mobile', 'operator'] }
    })
  })

  it('knows only the recipe’s own apps, never a name every object answers to', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(pickSimApp(recipe, name)).toEqual({
        ok: false,
        refusal: { code: 'unknown_app', app: name, apps: ['mobile', 'operator'] }
      })
      expect(parseSimRecipe({ ...recipe, default: name })).toMatchObject({
        recipe: null,
        diagnostics: [{ path: 'simulators.default', severity: 'error' }]
      })
    }
  })
})
