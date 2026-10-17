import { getStoredRepoSshConnectionId } from '../repo-execution-host'
import { readFile } from 'node:fs/promises'
import type { Repo } from '../../shared/repo-types'
import {
  getEffectiveHooks,
  hasHooksFile,
  hasUnrecognizedOrcaYamlKeys,
  loadHooks,
  parseOrcaYaml
} from '../hooks'
import { getEffectiveHooksFromConfig, getEffectiveSetupRunPolicy } from '../effective-hook-config'
import { readOrcaYamlAtRef, type GitShowExec } from '../orca-yaml-at-ref'
import { orcaYamlSetupTrust } from '../orca-yaml-setup-trust'
import { isENOENT } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isFolderRepo } from '../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

type RuntimeRepositoryHooksCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  /** Pod: git where the repo lives, to read a ref's orca.yaml; null when the host is unreachable. */
  gitShowExec?: (repo: Repo) => GitShowExec | null
}

export class RuntimeRepositoryHooksCommands {
  constructor(private readonly deps: RuntimeRepositoryHooksCommandsDeps) {}

  /** Pod: the ref's committed orca.yaml (the base a create would run), or null if unreadable. */
  private async atRef(repo: Repo, ref: string) {
    const exec = this.deps.gitShowExec?.(repo)
    return exec ? readOrcaYamlAtRef(exec, ref) : null
  }

  async getRepoHooks(repoSelector: string, ref?: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (ref) {
      const read = await this.atRef(repo, ref)
      const shared = read?.status === 'ok' ? read.hooks : null
      return {
        hasHooksFile: Boolean(read?.hasHooks),
        hooks: getEffectiveHooksFromConfig(repo, shared),
        setupRunPolicy: getEffectiveSetupRunPolicy(repo),
        source: read?.hasHooks ? ('orca.yaml' as const) : null,
        ...(read?.status === 'ok' ? {} : { status: 'error' as const }),
        setupTrust: orcaYamlSetupTrust(repo, shared)
      }
    }
    const connectionId = getStoredRepoSshConnectionId(repo)
    if (connectionId) {
      const fsProvider = getSshFilesystemProvider(connectionId)
      if (!fsProvider) {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        const hooks = result.isBinary ? null : parseOrcaYaml(result.content)
        return {
          hasHooksFile: Boolean(hooks),
          hooks,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: hooks ? ('orca.yaml' as const) : null,
          setupTrust: orcaYamlSetupTrust(repo, hooks)
        }
      } catch {
        return {
          hasHooksFile: false,
          hooks: null,
          setupRunPolicy: getEffectiveSetupRunPolicy(repo),
          source: null
        }
      }
    }
    const hasFile = hasHooksFile(repo.path)
    const hooks = getEffectiveHooks(repo)
    const sharedHooks = hasFile ? loadHooks(repo.path) : null
    return {
      hasHooksFile: hasFile,
      hooks,
      setupRunPolicy: getEffectiveSetupRunPolicy(repo),
      source: hasFile ? ('orca.yaml' as const) : hooks ? ('legacy' as const) : null,
      setupTrust: orcaYamlSetupTrust(repo, sharedHooks)
    }
  }

  async checkRepoHooks(repoSelector: string, ref?: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { status: 'ok' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    if (ref) {
      return (
        (await this.atRef(repo, ref)) ?? {
          status: 'error' as const,
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      )
    }
    const connectionId = getStoredRepoSshConnectionId(repo)
    if (connectionId) {
      const fsProvider = getSshFilesystemProvider(connectionId)
      if (!fsProvider) {
        return { status: 'error' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
      }
      try {
        const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
        if (result.isBinary) {
          return { status: 'ok' as const, hasHooks: false, hooks: null, mayNeedUpdate: false }
        }
        return {
          status: 'ok' as const,
          hasHooks: true,
          hooks: parseOrcaYaml(result.content),
          mayNeedUpdate: false
        }
      } catch (error) {
        return {
          status: isENOENT(error) ? ('ok' as const) : ('error' as const),
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false
        }
      }
    }
    const has = hasHooksFile(repo.path)
    const hooks = has ? loadHooks(repo.path) : null
    return {
      status: 'ok' as const,
      hasHooks: has,
      hooks,
      mayNeedUpdate: has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path)
    }
  }

  async inspectRepoSetupScriptImports(repoSelector: string) {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return []
    }
    return inspectSetupScriptImportCandidates(async (relativePath) => {
      const filePath = joinWorktreeRelativePath(repo.path, relativePath)
      const connectionId = getStoredRepoSshConnectionId(repo)
      if (connectionId) {
        const fsProvider = getSshFilesystemProvider(connectionId)
        if (!fsProvider) {
          return null
        }
        try {
          const result = await fsProvider.readFile(filePath)
          return result.isBinary ? null : result.content
        } catch {
          return null
        }
      }
      try {
        return await readFile(filePath, 'utf-8')
      } catch (error) {
        if (!isENOENT(error)) {
          console.warn('[runtime] Failed to inspect setup script import candidate:', error)
        }
        return null
      }
    })
  }
}
