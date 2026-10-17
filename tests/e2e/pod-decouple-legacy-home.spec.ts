import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Fork-only (Pod): the first start after the decouple on a Mac where Orca.app and an earlier Pod
// both wrote the legacy home. Only the isolated HOME the harness made is ever written.
// Why from identity.json: the decouple codemod rewrites these folder names wherever code spells them.
const identity = JSON.parse(readFileSync(path.join(process.cwd(), 'product/identity.json'), 'utf8'))
const PRODUCT_HOME: string = identity.homeDirName
const LEGACY_HOME: string = identity.legacyProfile.homeDirName

// Under names both apps write: the legacy app's, which must come through byte for byte.
const SHARED_FILES: Record<string, { body: string; mode: number }> = {
  'agent-hooks/claude-hook.sh': { body: '#!/bin/sh\n# the legacy app hook\nexit 0\n', mode: 0o755 },
  'agent-hooks/codex-hook.sh': { body: '#!/bin/sh\nexit 0\n', mode: 0o755 },
  'agent-hooks/.orca-managed-scripts.json': {
    body: '{"scripts":["claude-hook.sh"]}\n',
    mode: 0o644
  },
  'claude-agent-teams-bin/tmux': { body: '#!/bin/sh\nexec tmux "$@"\n', mode: 0o755 },
  'keybindings.json': { body: '{"keybindings":{"tab.newTerminal":"Mod+Alt+Y"}}\n', mode: 0o644 }
}
// What only the earlier Pod wrote there.
const PRODUCT_ONLY_FILES = ['agent-hooks/pod-agent-hook', 'agent-hooks/mcp-lazy']

function seedLegacyHome(home: string): void {
  for (const [name, { body, mode }] of Object.entries(SHARED_FILES)) {
    const file = path.join(home, LEGACY_HOME, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
    chmodSync(file, mode)
  }
  for (const name of PRODUCT_ONLY_FILES) {
    const file = path.join(home, LEGACY_HOME, name)
    writeFileSync(file, `#!/bin/sh\n# ${name} from before the decouple\nexit 0\n`)
    chmodSync(file, 0o755)
  }
}

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const stat = lstatSync(path.join(dir, name))
    return stat.isDirectory()
      ? filesUnder(path.join(dir, name), `${prefix}${name}/`)
      : [`${prefix}${name}`]
  })
}

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product/identity.json')
  },
  orcaAppSeedHome: { seed: seedLegacyHome }
})

test('the first start moves only its own hook files and copies the shared state', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform === 'win32', 'Pod ships for macOS')
  await waitForSessionReady(orcaPage)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const legacy = path.join(home, LEGACY_HOME)
  const product = path.join(home, PRODUCT_HOME)

  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(path.join(userData, 'product-home-copy.json'), 'utf8'))
          .result
      } catch {
        return null
      }
    })
    .toMatchObject({
      status: 'copied',
      moved: ['pod-agent-hook', 'mcp-lazy'],
      copied: ['keybindings.json']
    })

  // The legacy app's files, byte for byte and mode for mode, and nothing new beside them.
  for (const [name, { body, mode }] of Object.entries(SHARED_FILES)) {
    expect(readFileSync(path.join(legacy, name), 'utf8'), name).toBe(body)
    expect(lstatSync(path.join(legacy, name)).mode & 0o777, name).toBe(mode)
  }
  expect(filesUnder(legacy).sort()).toEqual(
    [...Object.keys(SHARED_FILES), ...PRODUCT_ONLY_FILES].sort()
  )
  // Its own files now live in the product's home; the old paths lead there.
  for (const name of PRODUCT_ONLY_FILES) {
    expect(lstatSync(path.join(legacy, name)).isSymbolicLink(), name).toBe(true)
    expect(readlinkSync(path.join(legacy, name)), name).toBe(path.join(product, name))
    expect(lstatSync(path.join(product, name)).isFile(), name).toBe(true)
  }
  // Shared state is copied, never moved: both apps keep theirs. Pod then fills in its own defaults.
  expect(JSON.parse(readFileSync(path.join(product, 'keybindings.json'), 'utf8'))).toMatchObject(
    JSON.parse(SHARED_FILES['keybindings.json']!.body)
  )
  expect(lstatSync(path.join(product, 'agent-hooks')).isDirectory()).toBe(true)
  // Hook scripts both apps write are never copied over: Pod installs its own.
  for (const name of ['agent-hooks/claude-hook.sh', 'agent-hooks/codex-hook.sh']) {
    const file = path.join(product, name)
    if (existsSync(file)) {
      expect(readFileSync(file, 'utf8'), name).not.toBe(SHARED_FILES[name]!.body)
    }
  }
})
