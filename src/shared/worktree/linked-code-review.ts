// Fork-only (Pod): a create linked to a pull or merge request starts from that request's head,
// code the repo's owner didn't write, so its orca.yaml setup is asked about on every create.
export type LinkedCodeReviewFields = {
  linkedPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
}

export function hasLinkedCodeReview(fields: LinkedCodeReviewFields): boolean {
  return [
    fields.linkedPR,
    fields.linkedGitLabMR,
    fields.linkedBitbucketPR,
    fields.linkedAzureDevOpsPR,
    fields.linkedGiteaPR
  ].some((value) => value != null)
}

/** A worktree made from someone else's code: marked so at create (`foreignOrigin`), or, for one made
 *  before Pod kept the mark, linked to a pull or merge request. */
export type ForeignWorktreeFields = LinkedCodeReviewFields & { foreignOrigin?: boolean }

export function isForeignWorktree(worktree: ForeignWorktreeFields | null | undefined): boolean {
  return Boolean(worktree && (worktree.foreignOrigin === true || hasLinkedCodeReview(worktree)))
}
