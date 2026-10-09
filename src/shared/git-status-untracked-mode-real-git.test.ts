import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe } from 'vitest'
import { runProcess } from '@orca/process-host'
import { registerAdaptiveGitStatusBinaryCompatibilityCases } from './git-status-untracked-binary-compatibility.test-cases'

describe('adaptive untracked status against real Git', () => {
  let root = ''
  let config = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-untracked-mode-'))
    config = join(root, 'empty-gitconfig')
    await writeFile(config, '')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })
  registerAdaptiveGitStatusBinaryCompatibilityCases(
    async (args) => {
      const result = await runProcess({
        program: 'git',
        args,
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: config,
          GIT_OPTIONAL_LOCKS: '0'
        }
      })
      if (result.code !== 0 || result.timedOut || result.outputTruncated) {
        throw new Error(`Fixture Git failed: ${result.stderr}`)
      }
      return { stdout: result.stdout, stderr: result.stderr }
    },
    (name) => ({ hostPath: join(root, name), gitCwd: join(root, name) })
  )
})
