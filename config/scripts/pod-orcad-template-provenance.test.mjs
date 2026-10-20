import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'
import {
  checkLanes,
  checkTemplate,
  podTemplateTargets,
  stagePayload,
  templateSource
} from './pod-orcad-template-provenance.mjs'

const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const roots = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const quietly = () => vi.spyOn(console, 'log').mockImplementation(() => {})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pod-orcad-provenance-'))
  roots.push(root)
  return root
}

async function writeSlot(slot) {
  const dir = join(await tempRoot(), 'orcad-prebuilds')
  await mkdir(join(dir, slot), { recursive: true })
  await writeFile(join(dir, slot, 'pty.node'), `${slot} addon`)
  await writeFile(join(dir, '.manifest.json'), JSON.stringify({ slots: { [slot]: {} } }))
  return dir
}

/** Two downloaded lanes, laid out as download-artifact leaves them. */
async function writeLanes(commits = { 'linux-x64-glibc': COMMIT, 'darwin-arm64': COMMIT }) {
  const lanes = join(await tempRoot(), 'lanes')
  for (const [slot, commit] of Object.entries(commits)) {
    stagePayload(
      await writeSlot(slot),
      join(lanes, `pod-orcad-lane-${slot}`),
      'prebuilds',
      `pod ${commit}\n`
    )
  }
  return lanes
}

/** A Pod template (no win32 slots) staged as the workflow uploads it, for run 42. */
async function writeTemplateDownload() {
  const resources = await tempRoot()
  const templateDir = await writeOrcadTemplateTestFixture(resources)
  const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const target of ['win32-x64', 'win32-arm64']) {
    delete manifest.targets[target]
    await rm(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target), { recursive: true })
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  const download = join(await tempRoot(), 'out')
  stagePayload(templateDir, download, 'orcad-template', templateSource(COMMIT, '42'))
  return download
}

describe('pod-orcad-template lanes', () => {
  const slots = ['linux-x64-glibc', 'darwin-arm64']

  it('accepts every expected lane built from the commit, dotfiles included', async () => {
    const lanes = await writeLanes()
    const sums = await readFile(
      join(lanes, 'pod-orcad-lane-darwin-arm64', 'prebuilds.SHA256SUMS'),
      'utf8'
    )

    expect(sums).toContain('  prebuilds/.manifest.json\n')
    expect(() => checkLanes(lanes, COMMIT, slots)).not.toThrow()
  })

  it('refuses a lane built from another commit', async () => {
    const lanes = await writeLanes({ 'linux-x64-glibc': COMMIT, 'darwin-arm64': OTHER })

    expect(() => checkLanes(lanes, COMMIT, slots)).toThrow(`not "pod ${COMMIT}\\n"`)
  })

  it('refuses a missing or an extra lane', async () => {
    const lanes = await writeLanes()

    expect(() => checkLanes(lanes, COMMIT, [...slots, 'linux-x64-musl'])).toThrow('not [')
    expect(() => checkLanes(lanes, COMMIT, ['darwin-arm64'])).toThrow('not [')
  })

  it('refuses a changed, an added or a removed file', async () => {
    const lanes = await writeLanes()
    const slotDir = join(lanes, 'pod-orcad-lane-linux-x64-glibc', 'prebuilds')
    await appendFile(join(slotDir, 'linux-x64-glibc', 'pty.node'), 'x')
    expect(() => checkLanes(lanes, COMMIT, slots)).toThrow('pty.node checksum mismatch')

    const added = await writeLanes()
    await writeFile(join(added, 'pod-orcad-lane-darwin-arm64', 'prebuilds', 'extra'), 'x')
    expect(() => checkLanes(added, COMMIT, slots)).toThrow('unlisted [prebuilds/extra]')

    const removed = await writeLanes()
    await rm(join(removed, 'pod-orcad-lane-darwin-arm64', 'prebuilds', '.manifest.json'))
    expect(() => checkLanes(removed, COMMIT, slots)).toThrow('missing [prebuilds/.manifest.json]')
  })
})

describe('pod-orcad-template download', () => {
  it('names the six non-Windows targets for the Pod profile', () => {
    expect(podTemplateTargets()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64-glibc',
      'linux-x64-glibc',
      'linux-arm64-musl',
      'linux-x64-musl'
    ])
  })

  it('accepts the run and commit it was built for', async () => {
    quietly()
    const download = await writeTemplateDownload()

    expect(() => checkTemplate(download, COMMIT, '42')).not.toThrow()
  })

  it('refuses another commit or another run', async () => {
    const download = await writeTemplateDownload()

    expect(() => checkTemplate(download, OTHER, '42')).toThrow('orcad-template.source reads')
    expect(() => checkTemplate(download, COMMIT, '43')).toThrow('orcad-template.source reads')
    expect(() => checkTemplate(download, 'main', '42')).toThrow('not a full commit SHA')
  })

  it('refuses a template whose files changed after the sums were taken', async () => {
    const download = await writeTemplateDownload()
    await writeFile(join(download, 'orcad-template', 'orcad.js'), 'tampered')

    expect(() => checkTemplate(download, COMMIT, '42')).toThrow('orcad.js checksum mismatch')
  })
})
