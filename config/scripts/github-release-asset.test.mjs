import { describe, expect, it } from 'vitest'
import { downloadReleaseAsset, PAYLOAD_TOKEN_ENV } from './github-release-asset.mjs'

const target = { repository: 'outof-place/claude-acc', tag: 'v1.34.2', asset: 'payload.tar.gz' }

function answering(routes) {
  const calls = []
  const download = async (url, init = {}) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) {
      return new Response('missing', { status: 404 })
    }
    return route()
  }
  return { download, calls }
}

describe('downloadReleaseAsset (Pod)', () => {
  it('reads a public asset without a token, and names the token when that fails', async () => {
    const publicUrl =
      'https://github.com/outof-place/claude-acc/releases/download/v1.34.2/payload.tar.gz'
    const ok = answering({ [publicUrl]: () => new Response('bytes') })
    await expect(
      downloadReleaseAsset({ ...target, token: null, download: ok.download })
    ).resolves.toEqual(Buffer.from('bytes'))
    const gone = answering({})
    await expect(
      downloadReleaseAsset({ ...target, token: null, download: gone.download })
    ).rejects.toThrow(PAYLOAD_TOKEN_ENV)
  })

  it('finds the asset by tag through the API and follows the redirect without the token', async () => {
    const assetUrl = 'https://api.github.com/repos/outof-place/claude-acc/releases/assets/7'
    const signed = 'https://objects.example/signed?sig=1'
    const { download, calls } = answering({
      'https://api.github.com/repos/outof-place/claude-acc/releases/tags/v1.34.2': () =>
        Response.json({
          assets: [
            { name: 'other', url: 'x' },
            { name: 'payload.tar.gz', url: assetUrl }
          ]
        }),
      [assetUrl]: () => new Response(null, { status: 302, headers: { location: signed } }),
      [signed]: () => new Response('private bytes')
    })

    await expect(downloadReleaseAsset({ ...target, token: 'tok', download })).resolves.toEqual(
      Buffer.from('private bytes')
    )

    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok' })
    expect(calls[1].init).toMatchObject({
      headers: { Accept: 'application/octet-stream', Authorization: 'Bearer tok' },
      redirect: 'manual'
    })
    expect(calls[2]).toEqual({ url: signed, init: {} })
  })

  it('takes the bytes when the API streams them itself', async () => {
    const assetUrl = 'https://api.github.com/repos/outof-place/claude-acc/releases/assets/7'
    const { download } = answering({
      'https://api.github.com/repos/outof-place/claude-acc/releases/tags/v1.34.2': () =>
        Response.json({ assets: [{ name: 'payload.tar.gz', url: assetUrl }] }),
      [assetUrl]: () => new Response('streamed')
    })
    await expect(downloadReleaseAsset({ ...target, token: 'tok', download })).resolves.toEqual(
      Buffer.from('streamed')
    )
  })

  it('says when the token reaches no release, or the release has no such asset', async () => {
    await expect(
      downloadReleaseAsset({ ...target, token: 'tok', download: answering({}).download })
    ).rejects.toThrow(`the ${PAYLOAD_TOKEN_ENV} token may not reach outof-place/claude-acc`)
    const { download } = answering({
      'https://api.github.com/repos/outof-place/claude-acc/releases/tags/v1.34.2': () =>
        Response.json({ assets: [] })
    })
    await expect(downloadReleaseAsset({ ...target, token: 'tok', download })).rejects.toThrow(
      'has no asset payload.tar.gz'
    )
  })
})
