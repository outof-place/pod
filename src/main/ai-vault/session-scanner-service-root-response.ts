import type { ChildProcess } from 'node:child_process'
import type { AiVaultServiceClientOptions } from './session-scanner-service-client-state'

/** Sends a fresh roots snapshot to the child that asked, unless it has been replaced since. */
export function answerAiVaultServiceRootRequest(
  child: ChildProcess | null,
  id: number,
  options: Pick<AiVaultServiceClientOptions, 'init' | 'resolveSessionSearchRoots'>,
  currentChild: () => ChildProcess | null
): void {
  const resolve = options.resolveSessionSearchRoots
  void Promise.resolve()
    .then(() => (resolve ? resolve() : (options.init().sessionSearch?.roots ?? null)))
    .catch(() => null)
    .then((roots) => {
      if (child && currentChild() === child && child.connected) {
        child.send({ type: 'sessionSearchRoots', id, roots }, () => undefined)
      }
    })
}
