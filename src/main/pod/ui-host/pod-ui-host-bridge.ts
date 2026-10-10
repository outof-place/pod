// Fork-only (Pod): the one-app hooks in upstream files send through here, so they import nothing
// heavier than this module; pod-ui-host.ts registers the attached PodNative as the sink.
import type { PodUiHostServerMessage } from './pod-ui-host-protocol'

type PodUiHostSink = { send: (message: PodUiHostServerMessage) => boolean }

let sink: PodUiHostSink | null = null

export function setPodUiHostSink(next: PodUiHostSink | null): void {
  sink = next
}

/** False when no PodNative is attached, so the caller keeps its own path. */
export function sendToPodUi(message: PodUiHostServerMessage): boolean {
  return sink?.send(message) ?? false
}
