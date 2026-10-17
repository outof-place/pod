import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultRepoHookSettings } from '../shared/constants'
import type { OrcaHooks, PersistedTrustedOrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import {
  orcaYamlSetupTrust,
  untrustedCreateSetup,
  untrustedRemovalArchive
} from './orca-yaml-setup-trust'
import {
  getDefaultTabCommandTrustContent,
  getEffectiveHooksFromConfig
} from './effective-hook-config'
import { hookRunContent } from '../shared/orca-yaml-run-content'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 0,
  hookSettings: getDefaultRepoHookSettings()
}
const yaml: OrcaHooks = { scripts: { setup: '  pnpm install  ' } }
const hash = createHash('sha256').update('pnpm install').digest('hex')
const store = (trusted: PersistedTrustedOrcaHooks = {}, repos: Repo[] = [repo]) => ({
  getRepos: () => repos,
  getUI: () => ({ trustedOrcaHooks: trusted })
})
const own = async (): Promise<boolean> => false
const foreign = async (): Promise<boolean> => true

describe('orca.yaml setup trust on the host (Pod)', () => {
  it('hashes the trimmed content, as the clients’ hashOrcaHookScript does', () => {
    expect(orcaYamlSetupTrust(repo, yaml)).toEqual({
      contentHash: hash,
      scriptContent: 'pnpm install'
    })
  })

  it('needs nothing when no shared command would run', async () => {
    expect(await untrustedCreateSetup(store(), repo, null, undefined, own)).toBeNull()
    const localOnly = {
      ...repo,
      hookSettings: { ...getDefaultRepoHookSettings(), commandSourcePolicy: 'local-only' as const }
    }
    expect(await untrustedCreateSetup(store(), localOnly, yaml, undefined, foreign)).toBeNull()
  })

  it('takes the approved hash, the recorded one, or repo-wide trust for a unique id', async () => {
    expect(await untrustedCreateSetup(store(), repo, yaml, hash, own)).toBeNull()
    const recorded = { 'repo-1': { setup: { contentHash: hash, approvedAt: 1 } } }
    expect(await untrustedCreateSetup(store(recorded), repo, yaml, undefined, own)).toBeNull()
    const all = { 'repo-1': { all: { approvedAt: 1 } } }
    expect(await untrustedCreateSetup(store(all), repo, yaml, undefined, own)).toBeNull()
    expect(
      await untrustedCreateSetup(
        store(all, [repo, { ...repo, path: '/other' }]),
        repo,
        yaml,
        undefined,
        own
      )
    ).toEqual({
      status: 'needs-trust',
      contentHash: hash
    })
  })

  it('takes only the approved hash for a create from someone else’s code', async () => {
    const recorded = { 'repo-1': { setup: { contentHash: hash, approvedAt: 1 } } }
    const all = { 'repo-1': { all: { approvedAt: 1 } } }
    for (const trusted of [recorded, all]) {
      expect(await untrustedCreateSetup(store(trusted), repo, yaml, undefined, foreign)).toEqual({
        status: 'needs-trust',
        contentHash: hash
      })
    }
    expect(await untrustedCreateSetup(store(all), repo, yaml, hash, foreign)).toBeNull()
  })

  it('asks git whether the create is foreign only when this create’s hash doesn’t settle it', async () => {
    const asked = vi.fn(async () => true)
    await untrustedCreateSetup(store(), repo, yaml, hash, asked)
    await untrustedCreateSetup(store(), repo, null, undefined, asked)
    expect(asked).not.toHaveBeenCalled()
    await untrustedCreateSetup(store(), repo, yaml, undefined, asked)
    expect(asked).toHaveBeenCalledOnce()
  })

  it('needs trust for other content, and trusts nothing without UI state but the approved hash', async () => {
    const other = { 'repo-1': { setup: { contentHash: 'a'.repeat(64), approvedAt: 1 } } }
    expect(await untrustedCreateSetup(store(other), repo, yaml, 'b'.repeat(64), own)).toEqual({
      status: 'needs-trust',
      contentHash: hash
    })
    expect(
      (await untrustedCreateSetup({ getRepos: () => [repo] }, repo, yaml, undefined, own))?.status
    ).toBe('needs-trust')
  })

  it('needs this create’s approval of everything someone else’s code would run, the repo’s own script too', async () => {
    const scripted = (policy: 'local-only' | 'run-both') => ({
      ...repo,
      hookSettings: {
        ...getDefaultRepoHookSettings(),
        commandSourcePolicy: policy,
        scripts: { setup: 'make setup', archive: '' }
      }
    })
    for (const policy of ['local-only', 'run-both'] as const) {
      const content = hookRunContent('setup', scripted(policy).hookSettings, yaml)
      const runHash = createHash('sha256').update(content).digest('hex')
      // The repo's own code: its own script is the user's; orca.yaml's part still needs trust.
      expect(await untrustedCreateSetup(store(), scripted(policy), yaml, undefined, own)).toEqual(
        policy === 'local-only' ? null : { status: 'needs-trust', contentHash: hash }
      )
      expect(
        await untrustedCreateSetup(store(), scripted(policy), yaml, undefined, foreign)
      ).toEqual({
        status: 'needs-trust',
        contentHash: runHash
      })
      expect(
        await untrustedCreateSetup(store(), scripted(policy), yaml, runHash, foreign)
      ).toBeNull()
    }
  })

  it('runs a foreign checkout’s archive script only with this removal’s hash', () => {
    const hash = createHash('sha256').update('make clean').digest('hex')
    expect(untrustedRemovalArchive(true, ' make clean ', undefined, '/w')?.message).toContain(
      'needs approval for this removal'
    )
    expect(untrustedRemovalArchive(true, 'make clean', 'f'.repeat(64), '/w')).not.toBeNull()
    expect(untrustedRemovalArchive(true, 'make clean', hash, '/w')).toBeNull()
    expect(untrustedRemovalArchive(false, 'make clean', undefined, '/w')).toBeNull()
    expect(untrustedRemovalArchive(true, '  ', undefined, '/w')).toBeNull()
  })

  it('hashes what the host would run: the clients’ shared content matches the main process’s', () => {
    const hooks: OrcaHooks = {
      scripts: { setup: ' pnpm i ', archive: ' rm -rf tmp ' },
      defaultTabs: [
        { title: 'dev', command: 'pnpm dev' },
        { command: ' ' },
        { command: 'tail -f log' }
      ]
    }
    expect(hookRunContent('setup', undefined, hooks)).toBe(getDefaultTabCommandTrustContent(hooks))
    for (const policy of ['local-only', 'run-both', 'shared-only'] as const) {
      const hookSettings = {
        ...getDefaultRepoHookSettings(),
        commandSourcePolicy: policy,
        scripts: { setup: 'make', archive: 'make clean' }
      }
      const effective = getEffectiveHooksFromConfig({ ...repo, hookSettings }, hooks)
      expect(hookRunContent('archive', hookSettings, hooks)).toBe(effective?.scripts.archive ?? '')
      expect(
        hookRunContent('setup', hookSettings, hooks).startsWith(effective?.scripts.setup ?? '')
      ).toBe(true)
    }
  })
})
