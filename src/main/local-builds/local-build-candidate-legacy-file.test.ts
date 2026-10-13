import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  LEGACY_LOCAL_BUILD_COMPATIBILITY_FILENAME,
  LOCAL_BUILD_COMPATIBILITY_FILENAME
} from '../../shared/local-build-compatibility'
import { loadLocalBuildCandidate } from './local-build-candidate'

// Fork-only (Pod): a local build from before pod-decouple carries its metadata under the old name.
const execFileAsync = promisify(execFile)
let directory = ''

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.runIf(
  process.platform === 'darwin' &&
    LEGACY_LOCAL_BUILD_COMPATIBILITY_FILENAME !== LOCAL_BUILD_COMPATIBILITY_FILENAME
)('names the old metadata file when a build carries only that one', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pod-local-build-legacy-'))
  const resources = join(directory, 'zip-root', 'Orca.app', 'Contents', 'Resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, LEGACY_LOCAL_BUILD_COMPATIBILITY_FILENAME), '{}')
  const artifactName = 'orca-macos-arm64.zip'
  const artifactPath = join(directory, artifactName)
  await execFileAsync('/usr/bin/zip', ['-qry', artifactPath, 'Orca.app'], {
    cwd: join(directory, 'zip-root')
  })
  const artifact = await readFile(artifactPath)
  const manifestPath = join(directory, 'latest-mac.yml')
  await writeFile(
    manifestPath,
    stringify({
      version: '1.2.3-local.1',
      files: [
        {
          url: artifactName,
          sha512: createHash('sha512').update(artifact).digest('base64'),
          size: artifact.length
        }
      ]
    })
  )
  await expect(loadLocalBuildCandidate(manifestPath, 'arm64')).rejects.toThrow(
    `before Pod renamed its compatibility metadata (${LEGACY_LOCAL_BUILD_COMPATIBILITY_FILENAME})`
  )
})
