// Fork-only (Pod): the windowless runtime host PodNative starts with `--serve --pod-headless-host`.
// Plain `--serve` (remote and VM hosts that pair clients over the WebSocket) is unchanged.

export const POD_HEADLESS_HOST_FLAG = '--pod-headless-host'

/** What the headless host leaves out. Each default cut has an env switch that brings the cost
 *  back; the isolation trades are opt-in. */
export type PodHeadlessHostCuts = {
  /** No runtime WebSocket listener: PodNative uses the unix socket. POD_HEADLESS_HOST_WEBSOCKET=1 keeps it. */
  dropWebSocket: boolean
  /** Close Electron's idle startup renderer. POD_HEADLESS_SPARE_RENDERER=1 keeps it. */
  releaseSpareRenderer: boolean
  /** GPU in the browser process (POD_HEADLESS_IN_PROCESS_GPU=1): one process fewer, no GPU sandbox. */
  inProcessGpu: boolean
  /** Network service in the browser process (POD_HEADLESS_IN_PROCESS_NETWORK=1). */
  inProcessNetwork: boolean
}

export function isPodHeadlessHost(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    argv.includes('--serve') &&
    (argv.includes(POD_HEADLESS_HOST_FLAG) || env.POD_HEADLESS_HOST === '1')
  )
}

/** Null outside the headless host. */
export function podHeadlessHostCuts(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): PodHeadlessHostCuts | null {
  if (!isPodHeadlessHost(argv, env)) {
    return null
  }
  return {
    dropWebSocket: env.POD_HEADLESS_HOST_WEBSOCKET !== '1',
    releaseSpareRenderer: env.POD_HEADLESS_SPARE_RENDERER !== '1',
    inProcessGpu: env.POD_HEADLESS_IN_PROCESS_GPU === '1',
    inProcessNetwork: env.POD_HEADLESS_IN_PROCESS_NETWORK === '1'
  }
}
