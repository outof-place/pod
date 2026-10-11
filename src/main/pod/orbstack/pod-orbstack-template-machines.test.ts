import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runEphemeralVmRecipeStart } from '../../../shared/ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import { createFakeOrb } from './pod-orbstack-fake-orb.test-support'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { POD_ORBSTACK_BUILTIN_RECIPE, podOrbstackMachineName } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createPodOrbstackTemplates } from './pod-orbstack-templates'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const release = { version: '2.1.296', platform: 'linux-arm64', dir: '/tmp/release' }

function setup(options: { recipe?: OrcaVmRecipe; running?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-template-machines-'))
  roots.push(root)
  const worktreePath = join(root, 'web')
  mkdirSync(worktreePath)
  const fake = { running: options.running, claudeVersion: release.version }
  const orb = createFakeOrb(fake)
  const registry = new PodOrbstackRegistry(join(root, 'registry.json'))
  const templates = createPodOrbstackTemplates({ run: orb.run, file: join(root, 'templates.json') })
  const provision = vi.fn(async () => ({ agentVersion: '2.1.296' }))
  const runRecipe = vi.fn(runEphemeralVmRecipeStart)
  let current = release
  // The Mac's Claude Code moved: the next release Pod prepares, and what the VM then reports.
  const moveClaude = (version: string) => {
    current = { ...release, version }
    fake.claudeVersion = version
  }
  const machines = createPodOrbstackMachines({
    paths: () => ({ appInstalled: true, orb: '/fake/orb', orbctl: '/fake/orbctl', docker: null }),
    run: orb.run,
    registry,
    loadRecipe: () => options.recipe ?? POD_ORBSTACK_BUILTIN_RECIPE,
    runRecipe,
    prepareClaudeRelease: async () => current,
    resolveMounts: async (path) => [path],
    provision,
    templates
  })
  const target = (folder: string) => {
    const path = join(root, folder)
    mkdirSync(path, { recursive: true })
    return { worktreeId: `repo::${path}`, worktreePath: path, displayName: folder }
  }
  return { orb, registry, templates, provision, runRecipe, machines, target, moveClaude }
}

const verbs = (calls: string[][]) => calls.map((call) => `${call[0]} ${call[1]}`)

describe('Pod OrbStack machines from templates', () => {
  it('builds the sandbox template on the first create and clones it after that', async () => {
    const { orb, registry, templates, provision, machines, target } = setup()
    const first = target('one')
    expect(await machines.createSandbox(first)).toEqual({ ok: true })
    const [template] = templates.list()
    expect(template).toMatchObject({ kind: 'sandbox', state: 'ready', agentVersion: '2.1.296' })
    orb.calls.length = 0

    const second = target('two')
    expect(await machines.createSandbox(second)).toEqual({ ok: true })
    const name = podOrbstackMachineName(second.worktreeId, second.worktreePath, 'sandbox')
    expect(orb.machines.get(name)).toMatchObject({
      isolated: true,
      isolateNetwork: true,
      running: true,
      mounts: [`${second.worktreePath}:${second.worktreePath}`]
    })
    // The clone path runs no image create, apt or Claude Code install.
    expect(verbs(orb.calls)).not.toContain('orb create')
    expect(verbs(orb.calls)).not.toContain('orb push')
    expect(verbs(orb.calls)).toContain('orb clone')
    expect(provision).not.toHaveBeenCalled()
    expect(registry.findByWorktree(second.worktreeId, 'sandbox')).toMatchObject({
      state: 'ready',
      agentVersion: '2.1.296',
      networkIsolated: true
    })
  })

  it('falls back to the full build when a clone is not isolated', async () => {
    const { orb, templates, provision, machines, target } = setup()
    expect(await machines.createSandbox(target('one'))).toEqual({ ok: true })
    const [template] = templates.list()
    const record = orb.machines.get(template?.name ?? '')
    if (record) {
      record.isolateNetwork = false
    }
    const second = target('two')
    expect(await machines.createSandbox(second)).toEqual({ ok: true })
    expect(provision).toHaveBeenCalledTimes(1)
    expect(orb.calls.some((call) => call[1] === 'delete')).toBe(true)
  })

  it('falls back to the full build when the template cannot be built', async () => {
    const { orb, templates, provision, machines, target } = setup()
    orb.failures.set('push', 'push failed')
    expect(await machines.createSandbox(target('one'))).toEqual({ ok: true })
    expect(provision).toHaveBeenCalledTimes(1)
    expect(templates.list()).toEqual([])
  })

  it("updates the sandbox template in place when the Mac's Claude Code moves", async () => {
    const { orb, templates, provision, machines, target, moveClaude } = setup()
    expect(await machines.createSandbox(target('one'))).toEqual({ ok: true })
    const [old] = templates.list()
    const address = orb.machines.get(old?.name ?? '')?.address
    moveClaude('2.1.297')
    orb.calls.length = 0
    await machines.prewarm()

    const [updated] = templates.list()
    expect(templates.list()).toHaveLength(1)
    expect(updated).toMatchObject({ state: 'ready', agentVersion: '2.1.297' })
    expect(updated?.name).not.toBe(old?.name)
    // Same machine, renamed: its address stays, and no image or apt step runs again.
    expect(orb.machines.get(updated?.name ?? '')).toMatchObject({
      address,
      isolated: true,
      isolateNetwork: true,
      running: false
    })
    expect(verbs(orb.calls)).toEqual(
      expect.arrayContaining(['orb rename', 'orb start', 'orb info', 'orb push', 'orb stop'])
    )
    expect(verbs(orb.calls)).not.toContain('orb create')
    expect(verbs(orb.calls)).not.toContain('orb delete')
    expect(provision).not.toHaveBeenCalled()

    // The next sandbox clones the updated template.
    expect(await machines.createSandbox(target('two'))).toEqual({ ok: true })
    expect(provision).not.toHaveBeenCalled()
  })

  it('builds the template fresh when the older one lost its isolation', async () => {
    const { orb, templates, machines, target, moveClaude } = setup()
    expect(await machines.createSandbox(target('one'))).toEqual({ ok: true })
    const [old] = templates.list()
    const record = orb.machines.get(old?.name ?? '')
    if (record) {
      record.isolateNetwork = false
    }
    moveClaude('2.1.297')
    orb.calls.length = 0
    await machines.prewarm()
    // The renamed machine is deleted; the next create builds the template from the image.
    expect(templates.list()).toEqual([])
    expect(orb.machines.size).toBe(1)
    expect(await machines.createSandbox(target('two'))).toEqual({ ok: true })
    expect(templates.list()).toMatchObject([{ agentVersion: '2.1.297' }])
    expect(verbs(orb.calls)).toContain('orb create')
  })

  it('clones worktree machines from the shared template for the built-in recipe only', async () => {
    const shared = setup()
    expect(await shared.machines.create(shared.target('one'))).toEqual({ ok: true })
    expect(shared.runRecipe).not.toHaveBeenCalled()
    expect(shared.templates.list()).toMatchObject([{ kind: 'shared', state: 'ready' }])

    // A recipe.json override runs as written (this one fails at once).
    const custom = setup({
      recipe: { ...POD_ORBSTACK_BUILTIN_RECIPE, id: 'custom', create: 'exit 3' }
    })
    expect(await custom.machines.create(custom.target('one'))).toMatchObject({ ok: false })
    expect(custom.runRecipe).toHaveBeenCalledTimes(1)
    expect(custom.templates.list()).toEqual([])
  })

  it('refreshes templates only for kinds in use and never while OrbStack is stopped', async () => {
    const idle = setup()
    await idle.machines.prewarm()
    expect(idle.templates.list()).toEqual([])

    const stopped = setup({ running: false })
    stopped.registry.upsert({
      name: 'pod-one-12345678-sbx',
      worktreeId: 'repo::/one',
      worktreePath: '/one',
      createdAt: 1,
      state: 'ready',
      kind: 'sandbox'
    })
    await stopped.machines.prewarm()
    expect(verbs(stopped.orb.calls)).toEqual(['orbctl status'])

    const used = setup()
    used.registry.upsert({
      name: 'pod-one-12345678-sbx',
      worktreeId: 'repo::/one',
      worktreePath: '/one',
      createdAt: 1,
      state: 'ready',
      kind: 'sandbox'
    })
    await used.machines.prewarm()
    expect(used.templates.list()).toMatchObject([{ kind: 'sandbox', agentVersion: '2.1.296' }])
  })
})
