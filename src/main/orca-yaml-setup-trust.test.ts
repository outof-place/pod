import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
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

describe('orca.yaml setup trust on the host (Pod)', () => {
  it('hashes the trimmed content, as the clients’ hashOrcaHookScript does', () => {
    expect(orcaYamlSetupTrust(repo, yaml)).toEqual({
      contentHash: hash,
      scriptContent: 'pnpm install'
    })
  })

  it('needs nothing when no shared command would run', () => {
    expect(untrustedCreateSetup(store(), repo, null, undefined)).toBeNull()
    const localOnly = {
      ...repo,
      hookSettings: { ...getDefaultRepoHookSettings(), commandSourcePolicy: 'local-only' as const }
    }
    expect(untrustedCreateSetup(store(), localOnly, yaml, undefined)).toBeNull()
  })

  it('takes the approved hash, the recorded one, or repo-wide trust for a unique id', () => {
    expect(untrustedCreateSetup(store(), repo, yaml, hash)).toBeNull()
    const recorded = { 'repo-1': { setup: { contentHash: hash, approvedAt: 1 } } }
    expect(untrustedCreateSetup(store(recorded), repo, yaml, undefined)).toBeNull()
    const all = { 'repo-1': { all: { approvedAt: 1 } } }
    expect(untrustedCreateSetup(store(all), repo, yaml, undefined)).toBeNull()
    expect(
      untrustedCreateSetup(store(all, [repo, { ...repo, path: '/other' }]), repo, yaml, undefined)
    ).toEqual({
      status: 'needs-trust',
      contentHash: hash
    })
  })

  it('needs trust for other content, and trusts nothing without UI state but the approved hash', () => {
    const other = { 'repo-1': { setup: { contentHash: 'a'.repeat(64), approvedAt: 1 } } }
    expect(untrustedCreateSetup(store(other), repo, yaml, 'b'.repeat(64))).toEqual({
      status: 'needs-trust',
      contentHash: hash
    })
    expect(untrustedCreateSetup({ getRepos: () => [repo] }, repo, yaml, undefined)?.status).toBe(
      'needs-trust'
    )
  })
})
