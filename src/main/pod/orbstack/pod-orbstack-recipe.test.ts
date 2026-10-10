import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  POD_ORBSTACK_BUILTIN_RECIPE,
  isValidPodOrbstackMachineName,
  loadPodOrbstackRecipe,
  podOrbstackMachineName
} from './pod-orbstack-recipe'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('podOrbstackMachineName', () => {
  it('is a stable pod- name from the folder plus a hash of the worktree id', () => {
    const name = podOrbstackMachineName(
      'repo-1::/Users/me/pod/acme/Web App',
      '/Users/me/pod/acme/Web App'
    )
    expect(name).toMatch(/^pod-web-app-[0-9a-f]{8}$/)
    expect(
      podOrbstackMachineName('repo-1::/Users/me/pod/acme/Web App', '/Users/me/pod/acme/Web App')
    ).toBe(name)
    expect(
      podOrbstackMachineName('repo-2::/Users/me/pod/acme/Web App', '/Users/me/pod/acme/Web App')
    ).not.toBe(name)
  })

  it('stays a valid hostname label for odd and long folder names', () => {
    for (const path of [
      '/x/___',
      '/x/Zażółć gęślą',
      `/x/${'a'.repeat(80)}`,
      '/x/-lead-and-trail-'
    ]) {
      const name = podOrbstackMachineName(`r::${path}`, path)
      expect(isValidPodOrbstackMachineName(name), name).toBe(true)
    }
  })

  it('rejects names that are not Pod machines', () => {
    expect(isValidPodOrbstackMachineName('ubuntu')).toBe(false)
    expect(isValidPodOrbstackMachineName('pod-')).toBe(false)
    expect(isValidPodOrbstackMachineName('pod-Upper')).toBe(false)
    expect(isValidPodOrbstackMachineName(`pod-${'a'.repeat(60)}`)).toBe(false)
  })
})

describe('Pod OrbStack recipe', () => {
  it('guards every machine command against an empty name', () => {
    for (const command of [
      POD_ORBSTACK_BUILTIN_RECIPE.create,
      POD_ORBSTACK_BUILTIN_RECIPE.suspend,
      POD_ORBSTACK_BUILTIN_RECIPE.resume,
      POD_ORBSTACK_BUILTIN_RECIPE.destroy
    ]) {
      expect(command).toMatch(/\$\{(ORCA_VM_INSTANCE_ID|name):\?/)
    }
  })

  it('uses an override file in the plugin recipe format', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-recipe-'))
    roots.push(root)
    const path = join(root, 'recipe.json')
    expect(loadPodOrbstackRecipe(path)).toBe(POD_ORBSTACK_BUILTIN_RECIPE)
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        id: 'custom',
        name: 'Custom',
        create: 'echo {}',
        destroy: 'none'
      })
    )
    expect(loadPodOrbstackRecipe(path)).toMatchObject({ id: 'custom', destroyDisabled: true })
    writeFileSync(path, '{"schemaVersion":2}')
    expect(() => loadPodOrbstackRecipe(path)).toThrow()
  })
})
