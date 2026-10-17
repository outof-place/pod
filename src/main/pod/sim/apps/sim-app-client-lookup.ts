// Fork-only (Pod): the dev client for a worktree's app, by its native fingerprint. In order: Pod's
// Mac-wide cache, the recipe's external cache (adopted into Pod's, never rebuilt), or the one build
// of that fingerprint for the whole Mac (joined when one runs). A failed build answers its refusal.
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'
import type { SimBuilds } from './sim-app-builds'
import type { SimClientCache } from './sim-app-clients'
import type { SimFingerprints } from './sim-app-fingerprint'
import type { SimHopTimer } from './sim-app-hops'

export type SimAppClient =
  | Readonly<{ state: 'cached'; path: string }>
  | Readonly<{ state: 'building'; buildId: string }>
  // No client can be had: the recipe has no fingerprint or build command, or the fingerprint
  // command failed; the lease goes on without the app.
  | Readonly<{ state: 'missing'; why: string }>

export type SimAppClientFound =
  | Readonly<{ fingerprint: string | null; client: SimAppClient }>
  | Readonly<{ refusal: SimRefusalInput }>

export type SimClientLookup = {
  /** This app's client; a cache miss starts or joins its build only when `startBuild`. */
  find(
    input: Readonly<{ worktreeRoot: string; id: string; app: SimRecipeApp; startBuild: boolean }>,
    time?: SimHopTimer
  ): Promise<SimAppClientFound>
  /** The `build_failed` refusal for a lease that build ended, with its log's tail. */
  buildRefusal(buildId: string, app?: string): Promise<SimRefusalInput | null>
}

export function createSimClientLookup(
  options: Readonly<{ fingerprints: SimFingerprints; clients: SimClientCache; builds: SimBuilds }>
): SimClientLookup {
  const { fingerprints, clients, builds } = options

  const buildRefusal = async (buildId: string, app?: string): Promise<SimRefusalInput | null> => {
    const build = await builds.get(buildId)
    if (!build) {
      return null
    }
    const tail = await builds.tail(build)
    const retry = builds.retryInMinutes(build)
    const appId = app ?? build.appId
    return {
      code: 'build_failed',
      buildId: build.buildId,
      logPath: build.logPath,
      ...(appId ? { app: appId.slice(0, 64) } : {}),
      ...(tail ? { logTail: tail } : {}),
      ...(retry ? { retryInMinutes: retry } : {})
    }
  }

  return {
    buildRefusal,

    async find({ worktreeRoot, id, app, startBuild }, time) {
      if (!app.fingerprint) {
        return {
          fingerprint: null,
          client: { state: 'missing', why: `simulators.apps.${id}.fingerprint is not set` }
        }
      }
      const fingerprint = await fingerprints.of({ worktreeRoot, appId: id, app })
      time?.hop('fingerprint')
      if (!fingerprint.ok) {
        return { fingerprint: null, client: { state: 'missing', why: fingerprint.message } }
      }
      const hash = fingerprint.hash
      const cached = await clients.find(app.bundleId, hash)
      if (cached) {
        void clients.touch(app.bundleId, hash)
        time?.hop('clientCache')
        return { fingerprint: hash, client: { state: 'cached', path: cached } }
      }
      if (app.clientCache) {
        const adopted = await clients.adoptExternal(app.clientCache, app.bundleId, hash)
        time?.hop('adopt')
        if (adopted?.ok) {
          void clients.evict(new Set([adopted.path])).catch(() => undefined)
          return { fingerprint: hash, client: { state: 'cached', path: adopted.path } }
        }
      }
      if (!startBuild) {
        return {
          fingerprint: hash,
          client: { state: 'missing', why: `no dev client for fingerprint ${hash} yet` }
        }
      }
      const build = await builds.ensure({ appId: id, app, fingerprint: hash, worktreeRoot })
      time?.hop('build')
      switch (build.state) {
        case 'building':
          return { fingerprint: hash, client: { state: 'building', buildId: build.build.buildId } }
        case 'failed': {
          const refusal = await buildRefusal(build.build.buildId, id)
          return refusal
            ? { refusal }
            : { fingerprint: hash, client: { state: 'missing', why: 'its build failed' } }
        }
        case 'done': {
          const path = await clients.find(app.bundleId, hash)
          return path
            ? { fingerprint: hash, client: { state: 'cached', path } }
            : { fingerprint: hash, client: { state: 'missing', why: 'its build landed no client' } }
        }
        case 'unbuildable':
          return { fingerprint: hash, client: { state: 'missing', why: build.message } }
      }
    }
  }
}
