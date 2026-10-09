// Fork-only (Pod): hosts Stably runs for Orca (docs, changelog, cloud, share), so a product without
// Stably's services can drop links that would send its users there.
const STABLY_HOST_DOMAINS = ['onorca.dev', 'orca.dev'] as const

export function isStablyHostedUrl(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return STABLY_HOST_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  )
}
