// Fork-only (Pod): the headless host's opt-in Chromium process merges. Chromium reads them only
// before app ready.
import { app } from 'electron'
import { podHeadlessHostCuts, type PodHeadlessHostCuts } from './headless-host-mode'

type CommandLine = Pick<typeof app.commandLine, 'appendSwitch' | 'getSwitchValue'>

export function applyPodHeadlessHostChromiumSwitches(
  cuts: PodHeadlessHostCuts | null = podHeadlessHostCuts(),
  commandLine: CommandLine = app.commandLine
): void {
  if (!cuts) {
    return
  }
  // Why opt-in: both move code that handles untrusted pages and network data out of its sandboxed
  // process into the browser process, so a crash or exploit there takes the host with it.
  if (cuts.inProcessGpu) {
    commandLine.appendSwitch('in-process-gpu')
  }
  if (cuts.inProcessNetwork) {
    // Why merged: later startup code appends its own features to this same switch.
    const existing = commandLine.getSwitchValue('enable-features')
    commandLine.appendSwitch(
      'enable-features',
      [existing, 'NetworkServiceInProcess2'].filter(Boolean).join(',')
    )
  }
}
