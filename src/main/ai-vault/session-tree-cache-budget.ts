export const SESSION_TREE_CACHE_MAX_ENTRIES = 64_000
export const SESSION_TREE_CACHE_MAX_BYTES = 24 * 1024 * 1024
export const SESSION_TREE_CACHE_MAX_ROOTS = 64

/** One host-wide ceiling for cached nodes and directory entries across all roots. */
export class SessionTreeCacheBudget {
  private retained = 0
  private retainedBytes = 0

  constructor(
    private readonly limit = SESSION_TREE_CACHE_MAX_ENTRIES,
    private readonly byteLimit = SESSION_TREE_CACHE_MAX_BYTES
  ) {}

  reserve(count: number, bytes: number): boolean {
    if (count > this.limit - this.retained || bytes > this.byteLimit - this.retainedBytes) {
      return false
    }
    this.retained += count
    this.retainedBytes += bytes
    return true
  }

  release(count: number, bytes: number): void {
    this.retained -= count
    this.retainedBytes -= bytes
  }
}
