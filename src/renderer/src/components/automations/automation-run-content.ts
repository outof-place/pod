import type { AutomationRun } from '../../../../shared/automations-types'

export function getAutomationRunContent(run: AutomationRun): string {
  // Pod: a setup the host skipped is said above whatever the run printed.
  const notice = run.setupNotice?.trim()
  const content = getRunOutputContent(run)
  return notice ? `${notice}\n\n${content}` : content
}

function getRunOutputContent(run: AutomationRun): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
  }
  return run.error ?? run.usage?.unavailableMessage ?? 'No output content available.'
}
