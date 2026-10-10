import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { gitExecFileAsync } from '../../git/runner'
import type { Repo } from '../../../shared/repo-types'

export type RealGitFixture = {
  root: string
  home: string
  globalConfig: string
  git: (cwd: string, ...args: string[]) => Promise<string>
  /** A bare origin with `main` (one commit) and a clone of it at `<root>/<name>`. */
  cloneWithOrigin: (name: string) => Promise<{ origin: string; repo: string }>
  commit: (cwd: string, file: string, message: string) => Promise<void>
  repoRecord: (path: string, id?: string) => Repo
  /** Orca's store as #27020's stray scan reads it: these repos, worktrees under `<root>/orca`. */
  store: (repos: Repo[]) => { getRepos: () => Repo[]; getSettings: () => GlobalSettings }
  dispose: () => void
}

/** Temp repos with an empty global config and HOME, so the user's git setup never leaks in. */
export async function createRealGitFixture(prefix: string): Promise<RealGitFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const home = join(root, 'home')
  mkdirSync(home)
  const globalConfig = join(home, '.gitconfig')
  writeFileSync(
    globalConfig,
    '[user]\n\tname = Pod Test\n\temail = pod@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[maintenance]\n\tauto = false\n'
  )
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('HOME', home)
  // Never let a test reach the user's launchd domain.
  vi.stubEnv('GIT_TEST_MAINT_SCHEDULER', 'launchctl:true')
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await gitExecFileAsync(args, { cwd })).stdout
  const commit = async (cwd: string, file: string, message: string): Promise<void> => {
    writeFileSync(join(cwd, file), `${message}\n`)
    await git(cwd, 'add', file)
    await git(cwd, 'commit', '-q', '-m', message)
  }
  const cloneWithOrigin = async (name: string) => {
    const seed = join(root, `${name}-seed`)
    const origin = join(root, `${name}-origin.git`)
    const repo = join(root, name)
    mkdirSync(seed)
    await git(seed, 'init', '-q')
    await commit(seed, 'README.md', 'initial')
    await git(root, 'clone', '-q', '--bare', seed, origin)
    await git(root, 'clone', '-q', origin, repo)
    return { origin, repo }
  }
  return {
    root,
    home,
    globalConfig,
    git,
    cloneWithOrigin,
    commit,
    repoRecord: (path, id = 'repo-1') => ({
      id,
      path,
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0,
      kind: 'git'
    }),
    store: (repos) => {
      const settings: GlobalSettings = {
        ...getDefaultSettings(root),
        workspaceDir: join(root, 'orca'),
        nestWorkspaces: false
      }
      return { getRepos: () => repos, getSettings: () => settings }
    },
    dispose: () => {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
