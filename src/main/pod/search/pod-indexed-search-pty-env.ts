// A local terminal's POD_INDEXED_SEARCH, which Pod's agent launcher reads
// (product/agent-launcher/agent-search.swift). Its own module: the PTY env assembly imports it, and
// nothing of the ogd client comes with it.

let enabled: () => boolean = () => false

/** installPodNativeSearch hands over the setting's reader. */
export function setPodIndexedSearchEnabled(isEnabled: () => boolean): void {
  enabled = isEnabled
}

/**
 * POD_INDEXED_SEARCH=1 while indexed search is on. A value inherited from a parent terminal is
 * dropped either way, so turning the setting off reaches every terminal opened after it.
 */
export function applyPodIndexedSearchPtyEnv(env: Record<string, string>): void {
  delete env.POD_INDEXED_SEARCH
  if (enabled()) {
    env.POD_INDEXED_SEARCH = '1'
  }
}
