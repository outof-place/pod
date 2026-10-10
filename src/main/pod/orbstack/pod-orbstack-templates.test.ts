import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeOrb } from './pod-orbstack-fake-orb.test-support'
import {
  createPodOrbstackTemplates,
  isPodOrbstackTemplateName,
  podOrbstackTemplateKey,
  podOrbstackTemplateName,
  SEAL_TEMPLATE
} from './pod-orbstack-templates'
import { resolveOrbstackTemplatesEnabled } from './pod-orbstack-tools'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-templates-'))
  roots.push(root)
  const orb = createFakeOrb()
  const file = join(root, 'templates.json')
  const templates = createPodOrbstackTemplates({ run: orb.run, file })
  // Stands in for provisionSandboxBase: an isolated machine with Claude.
  const provision = vi.fn(async (name: string) => {
    await orb.run('orb', ['create', '--isolated', '--isolate-network', 'ubuntu:24.04', name])
    return { agentVersion: '2.1.296' }
  })
  return { orb, file, templates, provision }
}

describe('Pod OrbStack templates', () => {
  it('is on by default, off by switch, and opt-in for E2E profiles', () => {
    expect(resolveOrbstackTemplatesEnabled({})).toBe(true)
    expect(resolveOrbstackTemplatesEnabled({ POD_ORBSTACK_TEMPLATES: '0' })).toBe(false)
    expect(resolveOrbstackTemplatesEnabled({ ORCA_E2E_USER_DATA_DIR: '/tmp/p' })).toBe(false)
    expect(
      resolveOrbstackTemplatesEnabled({
        ORCA_E2E_USER_DATA_DIR: '/tmp/p',
        POD_E2E_ORBSTACK_TEMPLATES: '1'
      })
    ).toBe(true)
  })

  it('names templates so no worktree machine name can take one', () => {
    const name = podOrbstackTemplateName('sandbox', podOrbstackTemplateKey('sandbox', '2.1.296'))
    expect(name).toMatch(/^pod-sbx-[0-9a-f]{8}-tmpl$/)
    expect(isPodOrbstackTemplateName(name)).toBe(true)
    expect(isPodOrbstackTemplateName('pod-tmpl-sbx-1234abcd')).toBe(false)
    expect(podOrbstackTemplateKey('sandbox', '2.1.296')).not.toBe(
      podOrbstackTemplateKey('sandbox', '2.1.297')
    )
  })

  it('builds a template once, leaves it stopped and records it', async () => {
    const { orb, templates, provision, file } = setup()
    const key = podOrbstackTemplateKey('sandbox', '2.1.296')
    const [first, second] = await Promise.all([
      templates.build('sandbox', key, provision),
      templates.build('sandbox', key, provision)
    ])
    expect(provision).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ kind: 'sandbox', state: 'ready', agentVersion: '2.1.296' })
    expect(orb.machines.get(first?.name ?? '')?.running).toBe(false)
    expect(await templates.find(key)).toEqual(first)
    // A new instance reads the record back from disk.
    const reread = createPodOrbstackTemplates({ run: orb.run, file })
    expect(await reread.find(key)).toEqual(first)
  })

  it('replaces the older template of a kind and keeps the other kind', async () => {
    const { orb, templates, provision } = setup()
    const shared = await templates.build(
      'shared',
      podOrbstackTemplateKey('shared', null),
      provision
    )
    const old = await templates.build(
      'sandbox',
      podOrbstackTemplateKey('sandbox', '2.1.295'),
      provision
    )
    const fresh = await templates.build(
      'sandbox',
      podOrbstackTemplateKey('sandbox', '2.1.296'),
      provision
    )
    expect(orb.machines.has(old?.name ?? '')).toBe(false)
    expect(orb.machines.has(fresh?.name ?? '')).toBe(true)
    expect(orb.machines.has(shared?.name ?? '')).toBe(true)
    expect(
      templates
        .list()
        .map((entry) => entry.name)
        .sort()
    ).toEqual([shared?.name, fresh?.name].sort())
  })

  it('never builds over or deletes a machine it did not record', async () => {
    const { orb, templates, provision } = setup()
    const key = podOrbstackTemplateKey('sandbox', '2.1.296')
    const name = podOrbstackTemplateName('sandbox', key)
    await orb.run('orb', ['create', 'ubuntu:24.04', name])
    expect(await templates.build('sandbox', key, provision)).toBeNull()
    expect(provision).not.toHaveBeenCalled()
    await templates.deleteAll()
    expect(orb.machines.has(name)).toBe(true)
  })

  it('deletes a half-built template and forgets a vanished one', async () => {
    const { orb, templates } = setup()
    const key = podOrbstackTemplateKey('sandbox', '2.1.296')
    const broken = await templates.build('sandbox', key, async (name) => {
      await orb.run('orb', ['create', 'ubuntu:24.04', name])
      throw new Error('apt failed')
    })
    expect(broken).toBeNull()
    expect(orb.machines.size).toBe(0)
    expect(templates.list()).toEqual([])

    const built = await templates.build('sandbox', key, async (name) => {
      await orb.run('orb', ['create', 'ubuntu:24.04', name])
      return { agentVersion: null }
    })
    orb.machines.delete(built?.name ?? '')
    expect(await templates.find(key)).toBeNull()
    expect(templates.list()).toEqual([])
  })

  it('clones with the first mount set, the rest added, then starts the clone', async () => {
    const { orb, templates, provision } = setup()
    const template = await templates.build(
      'sandbox',
      podOrbstackTemplateKey('sandbox', 'x'),
      provision
    )
    if (!template) {
      throw new Error('no template')
    }
    await templates.clone(template, 'pod-web-12345678-sbx', ['/Users/me/web', '/Users/me/.git'])
    expect(orb.machines.get('pod-web-12345678-sbx')).toMatchObject({
      isolated: true,
      isolateNetwork: true,
      running: true,
      mounts: ['/Users/me/web:/Users/me/web', '/Users/me/.git:/Users/me/.git']
    })
    await expect(
      templates.clone(template, 'pod-a-12345678-sbx', ['/Users/me/a,b'])
    ).rejects.toThrow('":" or ","')
    expect(orb.machines.has('pod-a-12345678-sbx')).toBe(false)
  })

  it('seals each template before it stops: an empty machine-id, no host keys', async () => {
    const { orb, templates, provision } = setup()
    const template = await templates.build(
      'sandbox',
      podOrbstackTemplateKey('sandbox', 'x'),
      provision
    )
    const seal = orb.calls.find((call) => call.includes(SEAL_TEMPLATE))
    expect(seal?.slice(0, 6)).toEqual(['orb', 'run', '-m', template?.name, '-u', 'root'])
    expect(SEAL_TEMPLATE).toContain('truncate -s 0 /etc/machine-id')
    expect(SEAL_TEMPLATE).toContain('rm -f /etc/ssh/ssh_host_*')
    const sealAt = orb.calls.indexOf(seal ?? [])
    const stopAt = orb.calls.findIndex((call) => call[1] === 'stop')
    expect(sealAt).toBeLessThan(stopAt)
  })

  it('turns off: deletes every template, then finds and builds none', async () => {
    const { orb, templates, provision, file } = setup()
    const key = podOrbstackTemplateKey('sandbox', 'x')
    const template = await templates.build('sandbox', key, provision)
    await templates.setEnabled(false)
    expect(orb.machines.has(template?.name ?? '')).toBe(false)
    expect(templates.list()).toEqual([])
    expect(await templates.find(key)).toBeNull()
    expect(await templates.build('sandbox', key, provision)).toBeNull()
    expect(createPodOrbstackTemplates({ run: orb.run, file }).enabled()).toBe(false)
    await templates.setEnabled(true)
    expect(await templates.build('sandbox', key, provision)).toMatchObject({ state: 'ready' })
  })
})
