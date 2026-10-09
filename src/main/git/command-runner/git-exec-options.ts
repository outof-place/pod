export { GIT_OUTPUT_MAX_BYTES as DEFAULT_GIT_MAX_BUFFER } from '../../../shared/git-output-byte-limit'

// Why: the admission tier is a wire value, so it is declared with its params schema.
import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'

export type { GitAdmissionTier }

export type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  /** Overrides only the default read deadline in tests; explicit timeout still wins. */
  timeoutMsForTest?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Cancels admission only; a running child still finishes. */
  admissionSignal?: AbortSignal
  /** Rechecks owner eligibility after admission, before starting the child. */
  canStart?: () => boolean
  wslDistro?: string
  preferWslDirectGit?: boolean
  useConfiguredSshCommandForNetwork?: boolean
  terminationBarrier?: boolean
  captureWslLoginShellOutput?: boolean
  /** Scheduler priority for this child; status is the safe default. */
  admissionTier?: GitAdmissionTier
  /** Skips general admission; only for a caller that bounds its own concurrency (worktree deletes). */
  admissionExempt?: true
}
