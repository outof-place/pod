import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BrowserScreenshotResult } from '../shared/runtime-types'
import { saveAgentScreenshotTempFile } from './agent-screenshot-temp-file'
import { RuntimeClientError, type RuntimeRpcSuccess } from './runtime-client'

export type SavedBrowserScreenshot = {
  format: BrowserScreenshotResult['format']
  path: string
  bytes: number
  expiresAt?: string
}

// Why: an agent looks at a file with its image tool; base64 on stdout only fills its context.
/** Writes the capture to `path` (relative to cwd), owner-only, and returns the reply without the base64. */
export function saveBrowserScreenshot(
  response: RuntimeRpcSuccess<BrowserScreenshotResult>,
  path: string,
  cwd: string
): RuntimeRpcSuccess<SavedBrowserScreenshot> {
  const absolutePath = resolve(cwd, path)
  const image = Buffer.from(response.result.data, 'base64')
  try {
    writeFileSync(absolutePath, image, { mode: 0o600 })
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'EIO'
    throw new RuntimeClientError(
      'invalid_argument',
      `Could not write the screenshot to ${absolutePath} (${code}).`
    )
  }
  return {
    ...response,
    result: { format: response.result.format, path: absolutePath, bytes: image.length }
  }
}

/** Saves the capture to a unique file in the CLI's screenshot temp dir; null keeps the base64 inline. */
export function saveBrowserScreenshotToTemp(
  response: RuntimeRpcSuccess<BrowserScreenshotResult>
): RuntimeRpcSuccess<SavedBrowserScreenshot> | null {
  try {
    const saved = saveAgentScreenshotTempFile(
      response.id,
      response.result.data,
      response.result.format
    )
    return {
      ...response,
      result: {
        format: response.result.format,
        path: saved.path,
        bytes: saved.bytes,
        expiresAt: saved.expiresAt
      }
    }
  } catch {
    return null
  }
}

export function formatSavedScreenshot(label: string, saved: SavedBrowserScreenshot): string {
  return `${label} saved to ${saved.path} (${saved.format}, ${saved.bytes} bytes)`
}
