import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultRepoHookSettings } from '../shared/constants'
import type { OrcaHooks, PersistedTrustedOrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import { orcaYamlSetupTrust, untrustedCreateSetup } from './orca-yaml-setup-trust'

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

  it('asks whether the create is foreign only when a recorded trust would decide', async () => {
    const asked = vi.fn(async () => true)
    await untrustedCreateSetup(store(), repo, yaml, hash, asked)
    await untrustedCreateSetup(store(), repo, yaml, undefined, asked)
    expect(asked).not.toHaveBeenCalled()
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
})
