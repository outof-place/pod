import {
  bootstrapBundledPlugins,
  type PluginBundledBootstrapResult
} from './plugin-bundled-bootstrap'

type PluginBundledBootstrapRequest = Parameters<typeof bootstrapBundledPlugins>[0]

export class PluginBundledBootstrapCoordinator {
  private readonly options: PluginBundledBootstrapRequest & {
    isEnabled: () => boolean
    refreshPlugins: () => Promise<void>
    bootstrap?: typeof bootstrapBundledPlugins
    /** A downstream product's own bundled plugins (root and index); null in upstream builds. */
    distro?: () => { root: string; indexFilename: string } | null
    /** Bundled distro plugins now on disk (installed or unchanged), after the refresh. */
    onDistroPlugins?: (pluginKeys: string[]) => Promise<void>
  }
  private pending: Promise<void> = Promise.resolve()

  constructor(options: PluginBundledBootstrapCoordinator['options']) {
    this.options = options
  }

  request(): Promise<PluginBundledBootstrapResult | null> {
    const run = this.pending.then(() => this.runOnce())
    // Why: feature-toggle and startup requests can overlap; preserve their
    // order even when one resource read fails.
    this.pending = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runOnce(): Promise<PluginBundledBootstrapResult | null> {
    if (!this.options.isEnabled()) {
      return null
    }
    const bootstrap = this.options.bootstrap ?? bootstrapBundledPlugins
    const request = {
      root: this.options.root,
      userDataPath: this.options.userDataPath,
      hostVersion: this.options.hostVersion,
      ...(this.options.blockedPluginReason
        ? { blockedPluginReason: this.options.blockedPluginReason }
        : {})
    }
    const result = await bootstrap(request)
    const distroSource = this.options.distro?.() ?? null
    const distro = distroSource
      ? await this.bootstrapDistro(bootstrap, { ...request, ...distroSource })
      : null
    if (distro) {
      result.installed.push(...distro.installed)
      result.unchanged.push(...distro.unchanged)
      result.errors.push(...distro.errors)
    }
    if (result.installed.length > 0) {
      await this.options.refreshPlugins()
    }
    if (distro && this.options.onDistroPlugins) {
      await this.options.onDistroPlugins([...distro.installed, ...distro.unchanged])
    }
    return result
  }

  private async bootstrapDistro(
    bootstrap: typeof bootstrapBundledPlugins,
    request: PluginBundledBootstrapRequest
  ): Promise<PluginBundledBootstrapResult | null> {
    try {
      return await bootstrap(request)
    } catch (error) {
      // Why: a build without the distro index (dev checkout, upstream resources) bundles nothing extra.
      if (Reflect.get(Object(error), 'code') === 'ENOENT') {
        return null
      }
      throw error
    }
  }
}
