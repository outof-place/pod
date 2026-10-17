import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultRepoHookSettings } from '../shared/constants'
import type { OrcaHooks, PersistedTrustedOrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import {
  needsTrustWarning,
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
    expect(await untrustedCreateSetup(store(), repo, null, {}, own)).toBeNull()
    const localOnly = {
      ...repo,
      hookSettings: { ...getDefaultRepoHookSettings(), commandSourcePolicy: 'local-only' as const }
    }
    expect(await untrustedCreateSetup(store(), localOnly, yaml, {}, foreign)).toBeNull()
  })

  it('takes the approved hash, the recorded one, or repo-wide trust for a unique id', async () => {
    expect(
      await untrustedCreateSetup(store(), repo, yaml, { setupTrustHash: hash }, own)
    ).toBeNull()
    const recorded = { 'repo-1': { setup: { contentHash: hash, approvedAt: 1 } } }
    expect(await untrustedCreateSetup(store(recorded), repo, yaml, {}, own)).toBeNull()
    const all = { 'repo-1': { all: { approvedAt: 1 } } }
    expect(await untrustedCreateSetup(store(all), repo, yaml, {}, own)).toBeNull()
    expect(
      await untrustedCreateSetup(
        store(all, [repo, { ...repo, path: '/other' }]),
        repo,
        yaml,
        {},
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
      expect(await untrustedCreateSetup(store(trusted), repo, yaml, {}, foreign)).toEqual({
        status: 'needs-trust',
        contentHash: hash
      })
    }
    expect(
      await untrustedCreateSetup(store(all), repo, yaml, { setupTrustHash: hash }, foreign)
    ).toBeNull()
  })

  it('asks git whether the create is foreign only when this create’s hash doesn’t settle it', async () => {
    const asked = vi.fn(async () => true)
    await untrustedCreateSetup(store(), repo, yaml, { setupTrustHash: hash }, asked)
    await untrustedCreateSetup(store(), repo, null, {}, asked)
    expect(asked).not.toHaveBeenCalled()
    await untrustedCreateSetup(store(), repo, yaml, {}, asked)
    expect(asked).toHaveBeenCalledOnce()
  })

  it('never runs an automation’s setup from someone else’s code, even with its hash', async () => {
    const run = { automationProvenance: { automationId: 'a1' } }
    const all = { 'repo-1': { all: { approvedAt: 1 } } }
    const skipped = {
      status: 'needs-trust' as const,
      contentHash: hash,
      reason: 'automation-foreign-base' as const
    }
    expect(
      await untrustedCreateSetup(store(all), repo, yaml, { ...run, setupTrustHash: hash }, foreign)
    ).toEqual(skipped)
    // A fork's ref can copy the base's orca.yaml: same hash, still not the repo's own code.
    const windowed = { automationProvenanceRequest: { automationId: 'a1' }, setupTrustHash: hash }
    expect(await untrustedCreateSetup(store(), repo, yaml, windowed, foreign)).toEqual(skipped)
    expect(
      await untrustedCreateSetup(store(), repo, yaml, { ...run, setupTrustHash: hash }, own)
    ).toBeNull()
    expect(await untrustedCreateSetup(store(), repo, null, run, foreign)).toBeNull()
    expect(needsTrustWarning('/w', skipped)).toMatch(
      /^setup skipped: base is outside your branches \(\/w\)/
    )
  })

  it('needs trust for other content, and trusts nothing without UI state but the approved hash', async () => {
    const other = { 'repo-1': { setup: { contentHash: 'a'.repeat(64), approvedAt: 1 } } }
    expect(
      await untrustedCreateSetup(store(other), repo, yaml, { setupTrustHash: 'b'.repeat(64) }, own)
    ).toEqual({
      status: 'needs-trust',
      contentHash: hash
    })
    expect(
      (await untrustedCreateSetup({ getRepos: () => [repo] }, repo, yaml, {}, own))?.status
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
      expect(await untrustedCreateSetup(store(), scripted(policy), yaml, {}, own)).toEqual(
        policy === 'local-only' ? null : { status: 'needs-trust', contentHash: hash }
      )
      expect(await untrustedCreateSetup(store(), scripted(policy), yaml, {}, foreign)).toEqual({
        status: 'needs-trust',
        contentHash: runHash
      })
      expect(
        await untrustedCreateSetup(
          store(),
          scripted(policy),
          yaml,
          { setupTrustHash: runHash },
          foreign
        )
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
