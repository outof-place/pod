export type GpuAccelerationAboutPanelOptions = {
  appName: string
  appVersion: string
  platform: NodeJS.Platform
  gpuFallbackActive: boolean
  gpuFeatureStatus: Pick<Electron.GPUFeatureStatus, 'gpu_compositing'> | null
  // A downstream product credits Orca (MIT) here.
  product?: { copyright: string; credits: string } | null
  // The Orca release/commit a downstream build is based on.
  upstream?: { tag: string | null; sha: string } | null
}

export function describeGpuAcceleration(
  gpuFeatureStatus: Pick<Electron.GPUFeatureStatus, 'gpu_compositing'> | null,
  gpuFallbackActive: boolean
): string {
  if (gpuFallbackActive) {
    return 'Disabled (Safe Graphics Mode)'
  }

  const compositing = gpuFeatureStatus?.gpu_compositing.trim().toLowerCase()
  if (!compositing || compositing === 'undefined') {
    return 'Status unavailable'
  }
  if (compositing === 'enabled') {
    return 'Enabled'
  }
  if (compositing.includes('software')) {
    return 'Software rendering'
  }
  if (compositing.startsWith('disabled')) {
    return 'Disabled'
  }
  if (compositing.startsWith('unavailable')) {
    return 'Unavailable'
  }
  return `Unknown (${compositing})`
}

export function createGpuAccelerationAboutPanelOptions({
  appName,
  appVersion,
  platform,
  gpuFallbackActive,
  gpuFeatureStatus,
  product,
  upstream
}: GpuAccelerationAboutPanelOptions): Electron.AboutPanelOptionsOptions {
  const status = `GPU acceleration: ${describeGpuAcceleration(gpuFeatureStatus, gpuFallbackActive)}`
  if (product) {
    const base = upstream
      ? `\nBased on Orca ${[upstream.tag, `(${upstream.sha.slice(0, 10)})`].filter(Boolean).join(' ')}`
      : ''
    return {
      applicationName: appName,
      applicationVersion: appVersion,
      copyright: product.copyright,
      credits: `${product.credits}${base}\n\n${status}`
    }
  }
  return {
    applicationName: appName,
    applicationVersion: appVersion,
    ...(platform === 'linux' ? { copyright: status } : { credits: status })
  }
}
