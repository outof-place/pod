import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  foreignOriginMeta,
  isForeignCreate,
  isOrcaYamlRef,
  isOwnBranch,
  readOrcaYamlAtRef,
  type GitShowExec
} from './orca-yaml-at-ref'

function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pod-orca-yaml-ref-')))
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    })
  git('init', '-q', '-b', 'main')
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@e.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i'
  )
  git('checkout', '-q', '-b', 'adds-setup')
  writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: touch pwned\n')
  git('add', 'orca.yaml')
  git('-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'setup')
  git('checkout', '-q', 'main')
  const exec: GitShowExec = async (args) => ({ stdout: git(...args) })
  return { exec, git }
}

describe('a ref’s orca.yaml (Pod)', () => {
  it('reads the base a create would run, not the checkout', async () => {
    const { exec } = fixture()
    const atBranch = await readOrcaYamlAtRef(exec, 'adds-setup')
    expect(atBranch).toMatchObject({ status: 'ok', hasHooks: true })
    expect(atBranch.hooks?.scripts.setup).toBe('touch pwned')
    expect(await readOrcaYamlAtRef(exec, 'main')).toEqual({
      status: 'ok',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })
  })

  it('fails closed for a ref git can’t read or that isn’t one', async () => {
    const { exec } = fixture()
    expect((await readOrcaYamlAtRef(exec, 'no-such-branch')).status).toBe('error')
    for (const ref of ['-p', 'main:orca.yaml', 'a b', '']) {
      expect(isOrcaYamlRef(ref)).toBe(false)
    }
  })

  it('tells the repo’s own branches from someone else’s code', async () => {
    const { exec, git } = fixture()
    const head = git('rev-parse', 'adds-setup').trim()
    git('update-ref', 'refs/remotes/origin/main', head)
    git('update-ref', 'refs/remotes/fork/evil', head)
    git('update-ref', 'refs/orca/pull/fork/7', head)
    for (const ref of ['main', 'adds-setup', 'origin/main']) {
      expect(await isOwnBranch(exec, ref)).toBe(true)
    }
    // A local branch is the repo's own while it tracks nothing or origin, not when it tracks a fork.
    for (const remote of ['origin', 'fork']) {
      git('config', `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`)
    }
    git('branch', 'tracks-origin', 'adds-setup')
    git('config', 'branch.tracks-origin.remote', 'origin')
    git('config', 'branch.tracks-origin.merge', 'refs/heads/main')
    git('branch', 'pr-fork-repo/evil', 'adds-setup')
    git('config', 'branch.pr-fork-repo/evil.remote', 'fork')
    git('config', 'branch.pr-fork-repo/evil.merge', 'refs/heads/evil')
    git('tag', 'v1')
    git('tag', 'main')
    expect(await isOwnBranch(exec, 'tracks-origin')).toBe(true)
    for (const ref of ['pr-fork-repo/evil', 'v1', 'main']) {
      expect(await isOwnBranch(exec, ref)).toBe(false)
    }
    git('tag', '-d', 'main')
    for (const ref of ['fork/evil', 'refs/orca/pull/fork/7', head, 'no-such-branch', '-q']) {
      expect(await isOwnBranch(exec, ref)).toBe(false)
    }
    expect(await isOwnBranch(null, 'main')).toBe(false)
    expect(await isForeignCreate(exec, {})).toBe(false)
    expect(await isForeignCreate(exec, { baseBranch: 'origin/main' })).toBe(false)
    expect(await isForeignCreate(exec, { baseBranch: head })).toBe(true)
    expect(await isForeignCreate(exec, { baseBranch: 'origin/main', linkedPR: 7 })).toBe(true)
    expect(await isForeignCreate(exec, { linkedGitLabMR: 3 })).toBe(true)
    expect(await isForeignCreate(exec, { linkedPR: null, baseBranch: 'main' })).toBe(false)
    expect(await foreignOriginMeta(exec, { baseBranch: head })).toEqual({ foreignOrigin: true })
    expect(await foreignOriginMeta(exec, { baseBranch: 'main' })).toEqual({})
  })
})
