// Fork-only (Pod): a ref's committed orca.yaml, for clients that ask the user to trust the setup a
// create from that ref will run (its base), not the root checkout's.
import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import {
  hasLinkedCodeReview,
  type LinkedCodeReviewFields
} from '../shared/worktree/linked-code-review'
import { gitExecFileAsync } from './git/runner'
import { parseOrcaYaml } from './hooks'
import type { Store } from './persistence'
import { getLocalProjectGitExecOptions } from './project-runtime-git-options'
import { getSshGitProvider } from './providers/ssh-git-dispatch'

export type GitShowExec = (args: string[]) => Promise<{ stdout: string }>

export type OrcaYamlAtRef = {
  status: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
}

const UNREADABLE: OrcaYamlAtRef = {
  status: 'error',
  hasHooks: false,
  hooks: null,
  mayNeedUpdate: false
}

/** A ref git can name as `<ref>:orca.yaml`: no option, no path separator, no whitespace. */
export function isOrcaYamlRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 1024 && !ref.startsWith('-') && !/[\s:]/.test(ref)
}

/**
 * `ls-tree` first: it answers for a missing file with an empty list on every host, where `cat-file`'s
 * error text differs between local git and the SSH relay. Any failure is `error`, so a caller
 * that asks the user fails closed.
 */
export async function readOrcaYamlAtRef(exec: GitShowExec, ref: string): Promise<OrcaYamlAtRef> {
  if (!isOrcaYamlRef(ref)) {
    return UNREADABLE
  }
  try {
    const listed = await exec([
      'ls-tree',
      '--name-only',
      '--end-of-options',
      ref,
      '--',
      'orca.yaml'
    ])
    if (!listed.stdout.trim()) {
      return { status: 'ok', hasHooks: false, hooks: null, mayNeedUpdate: false }
    }
    // cat-file, not show: the committed bytes, never through a textconv or filter.
    const shown = await exec(['cat-file', 'blob', '--end-of-options', `${ref}:orca.yaml`])
    const hooks = parseOrcaYaml(shown.stdout)
    return { status: 'ok', hasHooks: true, hooks, mayNeedUpdate: !hooks }
  } catch {
    return UNREADABLE
  }
}

/**
 * The repo's own branch: a local branch or one of origin's remote-tracking branches. Anything else
 * (a fork's head fetched for a pull request, another remote, a tag, a bare commit) and anything git
 * can't name is not, so a caller that asks the user fails closed.
 */
export async function isOwnBranch(exec: GitShowExec | null, ref: string): Promise<boolean> {
  if (!exec || !isOrcaYamlRef(ref)) {
    return false
  }
  try {
    const named = await exec(['rev-parse', '--verify', '--quiet', '--symbolic-full-name', ref])
    return /^refs\/(heads|remotes\/origin)\/\S/.test(named.stdout.trim())
  } catch {
    return false
  }
}

/**
 * A create from someone else's code: linked to a pull or merge request, or based on a ref that
 * isn't the repo's own branch. Its setup runs only on the hash approved for that create: "Always
 * trust" and a recorded hash were given for the repo's own content, and the same orca.yaml can
 * call a script the other branch changed. No base is the repo's default, its own.
 */
export async function isForeignCreate(
  exec: GitShowExec | null,
  create: LinkedCodeReviewFields & { baseBranch?: string }
): Promise<boolean> {
  if (hasLinkedCodeReview(create)) {
    return true
  }
  return create.baseBranch ? !(await isOwnBranch(exec, create.baseBranch)) : false
}

/** Runs git where the repo lives: this Mac's project runtime, or the SSH host's relay. */
export function repoGitShowExec(store: Store, repo: Repo): GitShowExec | null {
  if (!repo.connectionId) {
    return (args) => gitExecFileAsync(args, getLocalProjectGitExecOptions(store, repo))
  }
  const provider = getSshGitProvider(repo.connectionId)
  return provider ? (args) => provider.exec(args, repo.path) : null
}
