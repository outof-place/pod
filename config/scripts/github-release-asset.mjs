// Fork-only (Pod): downloads a GitHub release asset, from a private repository too. The payloads Pod
// ships (claude-acc, pod-search) are release assets, and once their repositories are private the
// public download URL answers 404. POD_PAYLOAD_TOKEN (a fine-grained token with read access to the
// repository's contents, the pod repository's secret in CI) reaches them through the REST API.
//
//   import { downloadReleaseAsset } from './github-release-asset.mjs'
//   const bytes = await downloadReleaseAsset({ repository, tag, asset })

export const PAYLOAD_TOKEN_ENV = 'POD_PAYLOAD_TOKEN'

const API = 'https://api.github.com'

function missingTokenHint(repository) {
  return (
    `set ${PAYLOAD_TOKEN_ENV} to a token that can read ${repository}'s contents ` +
    `(in CI: the ${PAYLOAD_TOKEN_ENV} secret of the pod repository)`
  )
}

/**
 * The asset's bytes. With a token: the release by tag through the REST API, then the asset with
 * `Accept: application/octet-stream` (a 302 to signed storage, or the bytes). Without one: the
 * public download URL, which works only while the repository is public.
 *
 * @param {{ repository: string, tag: string, asset: string, token?: string | null, download?: typeof fetch }} options
 * @returns {Promise<Buffer>}
 */
export async function downloadReleaseAsset({
  repository,
  tag,
  asset,
  token = process.env[PAYLOAD_TOKEN_ENV] || null,
  download = fetch
}) {
  if (!token) {
    const url = `https://github.com/${repository}/releases/download/${tag}/${asset}`
    const response = await download(url)
    if (!response.ok) {
      throw new Error(`GET ${url}: ${response.status}; ${missingTokenHint(repository)}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const releaseUrl = `${API}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
  const release = await download(releaseUrl, {
    headers: { ...headers, Accept: 'application/vnd.github+json' }
  })
  if (!release.ok) {
    // Why the hint: a token without access to a private repository gets 404, not 403.
    throw new Error(
      `GET ${releaseUrl}: ${release.status}; the ${PAYLOAD_TOKEN_ENV} token may not reach ${repository}`
    )
  }
  const { assets } = await release.json()
  const found = Array.isArray(assets) ? assets.find((entry) => entry?.name === asset) : undefined
  if (typeof found?.url !== 'string') {
    throw new Error(`${repository} release ${tag} has no asset ${asset}`)
  }
  // Why manual: the API answers 200 with the bytes or 302 to signed storage, which takes no token.
  const response = await download(found.url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
    redirect: 'manual'
  })
  const location =
    response.status >= 300 && response.status < 400 && response.headers.get('location')
  const bytes = location ? await download(location) : response
  if (!bytes.ok) {
    throw new Error(`GET ${location ? 'the signed asset URL' : found.url}: ${bytes.status}`)
  }
  return Buffer.from(await bytes.arrayBuffer())
}
