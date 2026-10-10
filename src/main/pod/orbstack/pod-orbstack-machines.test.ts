import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { POD_ORBSTACK_BUILTIN_RECIPE, podOrbstackMachineName } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createOrbstackToolRunner } from './pod-orbstack-tools'

// Why: a stand-in `orb` keeps machine state as files, so the real recipe runs without OrbStack.
const FAKE_ORB = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ORB_LOG"
state="$FAKE_ORB_STATE"
case "$1" in
  info) [ -f "$state/$2" ] ;;
  create) [ -z "\${FAKE_ORB_FAIL_CREATE:-}" ] || { echo "image pull failed" >&2; exit 1; }
    touch "$state/$3" ;;
  delete) rm -f "$state/$3" ;;
  start|stop) [ -f "$state/$2" ] ;;
  run) shift; [ "$1" = -m ] && shift 2; [ "$1" = -u ] && shift 2
    case "$1" in id) echo marcel ;; test) [ -d "$3" ] ;; esac ;;
esac
`

const roots: string[] = []
afterEach(() => {
  delete process.env.FAKE_ORB_LOG
  delete process.env.FAKE_ORB_STATE
  delete process.env.FAKE_ORB_FAIL_CREATE
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pod-orbstack-machines-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const state = join(root, 'state')
  const worktreePath = join(root, 'web')
  mkdirSync(bin)
  mkdirSync(state)
  mkdirSync(worktreePath)
  writeFileSync(join(bin, 'orb'), FAKE_ORB)
  chmodSync(join(bin, 'orb'), 0o755)
  process.env.FAKE_ORB_LOG = join(root, 'orb.log')
  process.env.FAKE_ORB_STATE = state
  const paths = () => ({ appInstalled: true, orb: join(bin, 'orb'), orbctl: null, docker: null })
  const registry = new PodOrbstackRegistry(join(root, 'registry.json'))
  const machines = createPodOrbstackMachines({
    paths,
    run: createOrbstackToolRunner(paths),
    registry,
    loadRecipe: () => POD_ORBSTACK_BUILTIN_RECIPE
  })
  const worktreeId = `repo::${worktreePath}`
  return {
    machines,
    registry,
    state,
    target: { worktreeId, worktreePath, displayName: 'web' },
    name: podOrbstackMachineName(worktreeId, worktreePath),
    log: (): string[] => readFileSync(join(root, 'orb.log'), 'utf8').trim().split('\n')
  }
}

describe.skipIf(process.platform === 'win32')('Pod OrbStack machines', () => {
  it('creates a pod- machine through the recipe, records it, then deletes it', async () => {
    const { machines, registry, state, target, name, log } = setup()

    expect(await machines.create(target)).toEqual({ ok: true })
    expect(existsSync(join(state, name))).toBe(true)
    expect(registry.findByWorktree(target.worktreeId)).toMatchObject({ name, state: 'ready' })
    expect(log()).toContain(`create ubuntu:24.04 ${name}`)
    expect(log()).toContain(`run -m ${name} test -d ${target.worktreePath}`)

    expect(await machines.stop(name)).toEqual({ ok: true })
    expect(await machines.start(name)).toEqual({ ok: true })
    expect(await machines.remove(target.worktreeId)).toEqual({ ok: true })
    expect(existsSync(join(state, name))).toBe(false)
    expect(registry.machines()).toEqual([])
  })

  it('forgets a failed create once the recipe has cleaned up', async () => {
    const { machines, registry, target } = setup()
    process.env.FAKE_ORB_FAIL_CREATE = '1'

    const result = await machines.create(target)

    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).toContain('image pull failed')
    expect(registry.machines()).toEqual([])
  })

  it('refuses to start, stop or delete machines Pod did not create', async () => {
    const { machines, state, log } = setup()
    writeFileSync(join(state, 'ubuntu'), '')
    writeFileSync(join(state, 'pod-not-mine'), '')

    for (const name of ['ubuntu', 'pod-not-mine']) {
      expect(await machines.stop(name)).toMatchObject({ ok: false })
      expect(await machines.start(name)).toMatchObject({ ok: false })
    }
    expect(await machines.remove('repo::/elsewhere')).toMatchObject({ ok: false })
    expect(existsSync(join(state, 'ubuntu'))).toBe(true)
    expect(existsSync(join(state, 'pod-not-mine'))).toBe(true)
    expect(existsSync(process.env.FAKE_ORB_LOG ?? '') ? log() : []).toEqual([])
  })

  it('runs one change per worktree at a time', async () => {
    const { machines, target } = setup()
    const [first, second] = await Promise.all([machines.create(target), machines.create(target)])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
  })
})

describe.skipIf(process.platform === 'win32')('Pod OrbStack agent sandboxes', () => {
  function sandboxSetup(provision: () => Promise<{ agentVersion: string | null }>) {
    const base = setup()
    const paths = () => ({
      appInstalled: true,
      orb: join(base.state, '..', 'bin', 'orb'),
      orbctl: null,
      docker: null
    })
    const machines = createPodOrbstackMachines({
      paths,
      run: createOrbstackToolRunner(paths),
      registry: base.registry,
      loadRecipe: () => POD_ORBSTACK_BUILTIN_RECIPE,
      hostClaudeVersion: async () => '2.1.295',
      resolveMounts: async (path) => [path],
      provision: async (args) => {
        // Stand-in for the real steps: the fake orb only needs the machine to exist.
        writeFileSync(join(base.state, args.name), '')
        return provision()
      }
    })
    return {
      ...base,
      machines,
      name: podOrbstackMachineName(base.target.worktreeId, base.target.worktreePath, 'sandbox')
    }
  }

  it('records a ready sandbox with the installed Claude version and deletes it by kind', async () => {
    const { machines, registry, state, target, name } = sandboxSetup(async () => ({
      agentVersion: '2.1.295'
    }))
    expect(name).toMatch(/-sbx$/)
    expect(await machines.createSandbox(target)).toEqual({ ok: true })
    expect(registry.findByWorktree(target.worktreeId, 'sandbox')).toMatchObject({
      name,
      state: 'ready',
      kind: 'sandbox',
      agentVersion: '2.1.295'
    })
    expect(registry.findByWorktree(target.worktreeId)).toBeNull()
    registry.setSandboxAgents(target.worktreeId, true)

    expect(await machines.remove(target.worktreeId, 'sandbox')).toEqual({ ok: true })
    expect(existsSync(join(state, name))).toBe(false)
    expect(registry.isSandboxAgents(target.worktreeId)).toBe(false)
  })

  it('deletes the half-built sandbox and forgets it when provisioning fails', async () => {
    const { machines, registry, state, target, name } = sandboxSetup(async () => {
      throw new Error('install Claude Code: curl: (6) Could not resolve host')
    })
    const result = await machines.createSandbox(target)
    expect(result).toEqual({
      ok: false,
      error: 'install Claude Code: curl: (6) Could not resolve host'
    })
    expect(existsSync(join(state, name))).toBe(false)
    expect(registry.machines()).toEqual([])
  })

  it('leaves an existing machine with the sandbox name alone', async () => {
    const { machines, registry, state, target, name } = sandboxSetup(async () => ({
      agentVersion: null
    }))
    writeFileSync(join(state, name), '')
    expect(await machines.createSandbox(target)).toMatchObject({ ok: false })
    expect(existsSync(join(state, name))).toBe(true)
    expect(registry.machines()).toEqual([])
  })
})
