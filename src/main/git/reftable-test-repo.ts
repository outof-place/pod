import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { configureRealGitTestRepo } from './real-git-test-repo'

/** `git init --ref-format` arrived in Git 2.45; older hosts skip reftable fixtures. */
export const GIT_SUPPORTS_REFTABLE = ((): boolean => {
  try {
    const match = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)/)
    const [major, minor] = [Number(match?.[1]), Number(match?.[2])]
    return major > 2 || (major === 2 && minor >= 45)
  } catch {
    return false
  }
})()

export function runGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

export type ReftableTestRepo = {
  repo: string
  worktree: string
  commonDir: string
  entryDir: string
}

/** `<root>/repo` on `main` with one commit, plus linked worktree `<root>/wt` on `feature`. */
export function createReftableRepoWithWorktree(
  root: string,
  objectFormat: 'sha1' | 'sha256' = 'sha1'
): ReftableTestRepo {
  const repo = join(root, 'repo')
  execFileSync('git', [
    'init',
    '--quiet',
    '--ref-format=reftable',
    `--object-format=${objectFormat}`,
    '--initial-branch=main',
    repo
  ])
  configureRealGitTestRepo(repo, { name: 'Test User', email: 'test@example.com' })
  runGit(repo, ['commit', '--quiet', '--allow-empty', '-m', 'one'])
  const worktree = join(root, 'wt')
  runGit(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
  return {
    repo,
    worktree,
    commonDir: join(repo, '.git'),
    entryDir: join(repo, '.git', 'worktrees', 'wt')
  }
}
