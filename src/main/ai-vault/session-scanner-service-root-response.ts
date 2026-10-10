import type {
  AiVaultServiceClientOptions,
  AiVaultServiceProcessFactory
} from './session-scanner-service-client-state'

// Typed through the client's factory, not node:child_process, whose imports @orca/process-host owns.
type ScannerChild = ReturnType<AiVaultServiceProcessFactory>

/** Sends a fresh roots snapshot to the child that asked, unless it has been replaced since. */
export function answerAiVaultServiceRootRequest(
  child: ScannerChild | null,
  id: number,
  options: Pick<AiVaultServiceClientOptions, 'init' | 'resolveSessionSearchRoots'>,
  currentChild: () => ScannerChild | null
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
