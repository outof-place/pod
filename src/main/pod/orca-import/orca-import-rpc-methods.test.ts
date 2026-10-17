import { afterEach, describe, expect, it, vi } from 'vitest'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { POD_ORCA_IMPORT_METHODS } from './orca-import-rpc-methods'
import { setOrcaImportService, type OrcaImportService } from './orca-import-service'

const methods = eraseRpcMethods(POD_ORCA_IMPORT_METHODS)

function from(kind: 'local-cli' | 'desktop' | 'paired-device', podNative?: boolean): RpcContext {
  const podNativePeer = podNative === undefined ? undefined : () => ({ ok: podNative, pid: 42 })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the caller's kind and the PodNative peer check.
  return { caller: { kind }, podNativePeer } as unknown as RpcContext
}

function call(name: string, params: unknown, context: RpcContext): unknown {
  const entry = methods.find((candidate) => candidate.name === name)
  if (!entry || isStreamingMethod(entry)) {
    throw new Error(`missing ${name}`)
  }
  return entry.handler(entry.params ? entry.params.parse(params) : undefined, context)
}

function install() {
  const service = {
    detect: vi.fn(() => ({ found: false })),
    preview: vi.fn(() => ({ status: 'not-found' })),
    apply: vi.fn(async () => ({ status: 'stale-preview' }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers call only these three methods.
  setOrcaImportService(service as unknown as OrcaImportService)
  return service
}

afterEach(() => {
  setOrcaImportService(null)
})

describe('podImport.* methods', () => {
  it('are host-admin, so no paired device or remote client holds them', () => {
    expect(methods.map((method) => [method.name, method.permission])).toEqual([
      ['podImport.orcaDetect', 'host-admin'],
      ['podImport.orcaPreview', 'host-admin'],
      ['podImport.orcaApply', 'host-admin']
    ])
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.orca-import.v1')
  })

  it('serve this machine’s own clients', async () => {
    const service = install()
    expect(call('podImport.orcaDetect', undefined, from('local-cli'))).toEqual({ found: false })
    expect(call('podImport.orcaPreview', { profileId: 'p1' }, from('desktop'))).toEqual({
      status: 'not-found'
    })
    await call(
      'podImport.orcaApply',
      { previewId: 'x', itemIds: ['repo:/a'], reason: 'user' },
      from('local-cli')
    )
    expect(service.preview).toHaveBeenCalledWith('p1')
    // The owner token alone (the CLI, any terminal) is not Pod's window.
    expect(service.apply).toHaveBeenLastCalledWith('x', ['repo:/a'], false)
    const apply = { previewId: 'x', itemIds: [], reason: 'user' }
    await call('podImport.orcaApply', apply, from('local-cli', true))
    expect(service.apply).toHaveBeenLastCalledWith('x', [], true)
    await call('podImport.orcaApply', apply, from('local-cli', false))
    expect(service.apply).toHaveBeenLastCalledWith('x', [], false)
    await call('podImport.orcaApply', apply, from('desktop'))
    expect(service.apply).toHaveBeenLastCalledWith('x', [], true)
  })

  it('refuse a paired device before reading anything', async () => {
    const service = install()
    for (const name of ['podImport.orcaDetect', 'podImport.orcaPreview']) {
      expect(() => call(name, {}, from('paired-device'))).toThrow(/only on this machine/)
    }
    await expect(
      call(
        'podImport.orcaApply',
        { previewId: 'x', itemIds: [], reason: 'user' },
        from('paired-device')
      )
    ).rejects.toThrow(/only on this machine/)
    expect(service.detect).not.toHaveBeenCalled()
    expect(service.preview).not.toHaveBeenCalled()
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('answer as a refusal in a build without the import', async () => {
    expect(call('podImport.orcaDetect', undefined, from('local-cli'))).toEqual({
      found: false,
      refused: 'no-legacy-identity'
    })
    expect(call('podImport.orcaPreview', {}, from('local-cli'))).toEqual({
      status: 'refused',
      reason: 'no-legacy-identity'
    })
    await expect(
      call('podImport.orcaApply', { previewId: 'x', itemIds: [], reason: 'user' }, from('desktop'))
    ).resolves.toEqual({ status: 'refused', reason: 'no-legacy-identity' })
  })

  it('apply needs the user’s own intent', () => {
    install()
    expect(() =>
      call('podImport.orcaApply', { previewId: 'x', itemIds: [] }, from('local-cli'))
    ).toThrow()
  })
})
