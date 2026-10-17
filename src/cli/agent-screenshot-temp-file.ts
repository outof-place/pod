import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Saves a base64 capture to the CLI-owned temp dir under a name unique to the request (owner-only,
 * expired by the hourly cleanup). Throws when the dir or file cannot be used; callers keep the
 * inline data then.
 */
export function saveAgentScreenshotTempFile(
  requestId: string,
  base64: string,
  format: unknown
): { path: string; expiresAt: string; bytes: number } {
  const extension = format === 'png' ? 'png' : format === 'jpeg' ? 'jpg' : 'img'
  const outputDir = computerScreenshotTempDir()
  cleanupComputerScreenshots(outputDir)
  const outputPath = join(outputDir, `${safeCliFileStem(requestId)}-screenshot.${extension}`)
  const image = Buffer.from(base64, 'base64')
  writeFileSync(outputPath, image, { mode: 0o600 })
  return {
    path: outputPath,
    expiresAt: new Date(Date.now() + COMPUTER_SCREENSHOT_TTL_MS).toISOString(),
    bytes: image.length
  }
}

const COMPUTER_SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const COMPUTER_SCREENSHOT_CLEANUP_MARKER = '.last-cleanup'
const SCREENSHOT_TEMP_SUFFIXES = ['-screenshot.png', '-screenshot.jpg', '-screenshot.img']

function computerScreenshotTempDir(): string {
  const outputDir =
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR || join(tmpdir(), 'orca-computer-use')
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(outputDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe computer screenshot temp path: ${outputDir}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Computer screenshot temp path is not owned by the current user: ${outputDir}`)
  }
  chmodSync(outputDir, 0o700)
  return outputDir
}

function cleanupComputerScreenshots(outputDir: string): void {
  const now = Date.now()
  const markerPath = join(outputDir, COMPUTER_SCREENSHOT_CLEANUP_MARKER)
  try {
    // Why: agents can call computer-use CLI commands in loops; a marker keeps
    // temp cleanup from becoming a synchronous directory scan per screenshot.
    if (statSync(markerPath).mtimeMs > now - COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS) {
      return
    }
  } catch {
    // Missing or unreadable marker means this process should attempt cleanup.
  }

  const cutoff = now - COMPUTER_SCREENSHOT_TTL_MS
  for (const entry of readdirSync(outputDir)) {
    if (!SCREENSHOT_TEMP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      continue
    }
    const path = join(outputDir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true })
      }
    } catch {
      // Best-effort cleanup only; formatting should not fail because a temp file raced.
    }
  }
  try {
    writeFileSync(markerPath, `${now}\n`, { mode: 0o600 })
  } catch {
    // Best-effort marker only; stale cleanup state should not hide a screenshot.
  }
}

function safeCliFileStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}
