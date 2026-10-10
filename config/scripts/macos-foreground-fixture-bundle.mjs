import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function isWithin(root, path) {
  const suffix = relative(root, path)
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

function visitAppEntries(app, visit) {
  const canonicalRoot = realpathSync(app)
  const directories = [app]
  let count = 0
  while (directories.length) {
    const directory = directories.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(++count < 10_000, 'unexpected fixture size')
      const path = join(directory, entry.name)
      assert(isWithin(canonicalRoot, realpathSync(path)), `bundle entry escapes its app: ${path}`)
      visit(path, entry)
      if (entry.isDirectory()) {
        directories.push(path)
      }
    }
  }
  return count
}

function fileState(path) {
  const stat = lstatSync(path)
  assert(stat.isFile(), `source is not a direct regular file: ${path}`)
  const digest = createHash('sha256')
  const file = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytes
    while ((bytes = readSync(file, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytes))
    }
  } finally {
    closeSync(file)
  }
  return {
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    digest: digest.digest('hex')
  }
}

function sourceState(sourceApp, sourceAddon) {
  const files = new Map()
  visitAppEntries(sourceApp, (path, entry) => {
    const stat = lstatSync(path)
    files.set(
      relative(sourceApp, path),
      entry.isFile()
        ? fileState(path)
        : {
            mtime: stat.mtimeMs,
            ctime: stat.ctimeMs,
            link: entry.isSymbolicLink() ? readlinkSync(path) : null
          }
    )
  })
  const signature = spawnSync('codesign', ['--display', '--verbose=2', sourceApp], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  const root = lstatSync(sourceApp)
  return {
    root: { dev: root.dev, ino: root.ino, mtime: root.mtimeMs, ctime: root.ctimeMs },
    files,
    addon: fileState(sourceAddon),
    signature: {
      status: signature.status,
      signal: signature.signal,
      error: signature.error?.code ?? null,
      digest: createHash('sha256')
        .update((signature.stdout ?? '') + (signature.stderr ?? ''))
        .digest('hex')
    }
  }
}

/** Copy and sign an isolated bundle while preserving its original Electron files. */
export function createForegroundFixtureBundle({ sourceApp, sourceAddon, app, scratch }) {
  const scratchIdentity = lstatSync(scratch)
  assert(scratchIdentity.isDirectory(), 'scratch must be a direct directory')
  const scratchRoot = realpathSync(scratch)
  const originalApp = realpathSync(sourceApp)
  const fixtureApp = resolve(app)
  const fixtureLocation = relative(resolve(scratch), fixtureApp)
  assert(fixtureLocation && isWithin(resolve(scratch), fixtureApp), 'app must be inside scratch')
  const canonicalApp = join(scratchRoot, fixtureLocation)
  const parent = dirname(fixtureApp)
  assert(lstatSync(parent).isDirectory(), 'fixture parent must be a direct directory')
  assert.equal(realpathSync(parent), dirname(canonicalApp), 'fixture parent moved outside scratch')
  assert(!isWithin(scratchRoot, originalApp), 'source app must be outside scratch')
  assert(!isWithin(scratchRoot, realpathSync(sourceAddon)), 'source addon must be outside scratch')
  assert.equal(lstatSync(fixtureApp, { throwIfNoEntry: false }), undefined, 'fixture app exists')
  const originalState = sourceState(originalApp, sourceAddon)
  let validatedEntries = 0
  let removed = false

  function assertScratchOwned() {
    const current = lstatSync(scratch)
    assert(
      current.isDirectory() &&
        current.dev === scratchIdentity.dev &&
        current.ino === scratchIdentity.ino,
      'scratch directory identity changed'
    )
    assert.equal(realpathSync(scratch), scratchRoot, 'scratch directory moved')
  }

  function validate() {
    assertScratchOwned()
    assert(lstatSync(fixtureApp).isDirectory(), 'fixture app must be a direct directory')
    assert.equal(realpathSync(fixtureApp), canonicalApp, 'fixture app moved outside scratch')
    validatedEntries = visitAppEntries(fixtureApp, (path, entry) => {
      if (entry.isFile()) {
        assert.equal(lstatSync(path).nlink, 1, `fixture file is hard-linked: ${path}`)
      }
    })
  }

  function assertSourcesPreserved() {
    assert.deepEqual(
      sourceState(originalApp, sourceAddon),
      originalState,
      'fixture altered original Electron or addon files'
    )
  }

  function removeScratch() {
    if (removed) {
      return
    }
    assertScratchOwned()
    rmSync(scratch, { recursive: true, force: true })
    removed = true
  }

  function cleanup() {
    try {
      assertSourcesPreserved()
    } finally {
      removeScratch()
    }
    assertSourcesPreserved()
  }

  function seal() {
    validate()
    const options = {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', fixtureApp], options)
    execFileSync('codesign', ['--verify', '--deep', '--strict', fixtureApp], options)
  }

  try {
    cpSync(originalApp, fixtureApp, { recursive: true, verbatimSymlinks: true })
    validate()
  } catch (error) {
    cleanup()
    throw error
  }
  return {
    validate,
    seal,
    assertSourcesPreserved,
    cleanup,
    get validatedEntries() {
      return validatedEntries
    }
  }
}
