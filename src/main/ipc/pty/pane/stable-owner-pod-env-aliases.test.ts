// Fork-only (Pod): a spawn request carries user POD_ settings as ORCA_ too, but no alias
// (pod-env-aliases.ts, mode 'request'), so a daemon from before the aliases never splits a value.
import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtySpawnOptions } from '../../../providers/types'
import { spawnForStablePane } from './stable-owner'
import { podEnvAliasProviderDouble } from '../../../pod/decouple/pod-env-aliases.test-support'

async function spawnRequest(spawnOptions: PtySpawnOptions): Promise<PtySpawnOptions> {
  const spawn = vi.fn<IPtyProvider['spawn']>(async () => ({ id: 'pty-1', isReattach: false }))
  const provider = podEnvAliasProviderDouble(spawn)
  await spawnForStablePane({ runtime: undefined, provider, spawnOptions, owner: null })
  return spawn.mock.calls[0][0]
}

describe('spawnForStablePane POD_ env', () => {
  it('normalizes a user POD_ setting and adds no alias', async () => {
    const sent = await spawnRequest({
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_GITEA_TOKEN: 'orca', POD_GITEA_TOKEN: 'pod' }
    })
    expect(sent.env).toEqual({
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_GITEA_TOKEN: 'pod',
      POD_GITEA_TOKEN: 'pod'
    })
  })

  it('deletes the POD_ spelling of every name the request deletes', async () => {
    const sent = await spawnRequest({
      cols: 80,
      rows: 24,
      env: { POD_GITEA_TOKEN: 'pod' },
      envToDelete: ['ORCA_TAB_ID', 'ORCA_GITEA_TOKEN']
    })
    expect(sent.env).toEqual({ POD_GITEA_TOKEN: 'pod' })
    expect(sent.envToDelete).toEqual([
      'ORCA_TAB_ID',
      'ORCA_GITEA_TOKEN',
      'POD_GITEA_TOKEN',
      'POD_TAB_ID'
    ])
  })
})
