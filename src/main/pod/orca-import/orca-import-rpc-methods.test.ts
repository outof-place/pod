import { afterEach, describe, expect, it, vi } from 'vitest'
import { POD_RUNTIME_CAPABILITIES } from '../../../shared/pod-runtime-capabilities'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { POD_ORCA_IMPORT_METHODS } from './orca-import-rpc-methods'
import { setOrcaImportService, type OrcaImportService } from './orca-import-service'

const methods = eraseRpcMethods(POD_ORCA_IMPORT_METHODS)

function from(kind: 'local-cli' | 'desktop' | 'paired-device'): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the caller's kind.
  return { caller: { kind } } as unknown as RpcContext
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
    expect(service.apply).toHaveBeenCalledWith('x', ['repo:/a'])
  })

  it('refuse a paired device before reading anything', () => {
    const service = install()
    for (const name of ['podImport.orcaDetect', 'podImport.orcaPreview']) {
      expect(() => call(name, {}, from('paired-device'))).toThrow(/only on this machine/)
    }
    expect(() =>
      call(
        'podImport.orcaApply',
        { previewId: 'x', itemIds: [], reason: 'user' },
        from('paired-device')
      )
    ).toThrow(/only on this machine/)
    expect(service.detect).not.toHaveBeenCalled()
    expect(service.preview).not.toHaveBeenCalled()
    expect(service.apply).not.toHaveBeenCalled()
  })

  it('apply needs the user’s own intent', () => {
    install()
    expect(() =>
      call('podImport.orcaApply', { previewId: 'x', itemIds: [] }, from('local-cli'))
    ).toThrow()
  })
})
