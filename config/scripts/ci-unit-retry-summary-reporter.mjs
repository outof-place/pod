// Fork-only (Pod): pod-check runs the unit tests with --retry=1. This lists every test that needed
// the retry in the log and the step summary, so a flaky pass stays visible.
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'

function appendStepSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  }
}

export default class UnitRetrySummaryReporter {
  constructor({ write = appendStepSummary, log = console.log } = {}) {
    this.write = write
    this.log = log
    this.retried = []
  }

  onInit(ctx) {
    this.ctx = ctx
  }

  onTestCaseResult(testCase) {
    const retries = testCase.diagnostic()?.retryCount ?? 0
    if (retries > 0) {
      this.retried.push({
        file: relative(this.ctx.config.root, testCase.module.moduleId).replaceAll('\\', '/'),
        name: testCase.fullName,
        retries,
        passed: testCase.result().state === 'passed'
      })
    }
  }

  onTestRunEnd() {
    const shard = this.ctx.config.shard
    const label = shard ? `Unit tests ${shard.index}/${shard.count}` : 'Unit tests'
    const lines =
      this.retried.length === 0
        ? [`${label}: no test needed a retry.`]
        : [
            `${label}: ${this.retried.length} test(s) needed a retry.`,
            ...this.retried.map(
              ({ file, name, retries, passed }) =>
                `- ${passed ? 'passed on retry' : 'failed'} (${retries}): ${file} > ${name}`
            )
          ]
    const text = `${lines.join('\n')}\n`
    this.log(text.trimEnd())
    this.write(text)
  }
}
