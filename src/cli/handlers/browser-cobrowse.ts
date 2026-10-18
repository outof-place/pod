// Fork-only (Pod): co-browse's agent verbs. `marks` takes what the user marked on the tab (waiting for
// it with --wait), `point` shows the user an element or a region on the tab's pane.
import {
  COBROWSE_LIMITS,
  formatCobrowseMarksMarkdown,
  type CobrowseMark,
  type CobrowseMarksResult,
  type CobrowsePointResult
} from '../../shared/browser-cobrowse-types'
import { saveAgentScreenshotTempFile } from '../agent-screenshot-temp-file'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag
} from '../flags'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { getBrowserCommandTarget } from '../selectors'

// Why: an older runtime has no such method, and "Unknown method" says nothing about what to do.
function explainOlderRuntime(error: unknown): never {
  if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
    throw new RuntimeClientError(
      'unsupported',
      'This Pod runtime has no marks or pointers (co-browse); update Pod.'
    )
  }
  throw error
}

type SavedShot = { path: string; width: number; height: number; bytes: number }
type SavedMark = Omit<CobrowseMark, 'screenshot'> & {
  screenshot: SavedShot | CobrowseMark['screenshot']
}

// --save: each screenshot in its own private file (as `screenshot --save`), its path in the reply.
function saveShots(response: RuntimeRpcSuccess<CobrowseMarksResult>): {
  response: RuntimeRpcSuccess<Omit<CobrowseMarksResult, 'marks'> & { marks: SavedMark[] }>
  paths: Map<string, string>
} {
  const paths = new Map<string, string>()
  const marks = response.result.marks.map((mark): SavedMark => {
    if (!mark.screenshot) {
      return mark
    }
    try {
      const saved = saveAgentScreenshotTempFile(
        `${response.id}-mark-${mark.n}`,
        mark.screenshot.data,
        'png'
      )
      paths.set(mark.id, saved.path)
      return {
        ...mark,
        screenshot: {
          path: saved.path,
          width: mark.screenshot.width,
          height: mark.screenshot.height,
          bytes: saved.bytes
        }
      }
    } catch {
      return mark
    }
  })
  return { response: { ...response, result: { ...response.result, marks } }, paths }
}

export const BROWSER_COBROWSE_HANDLERS: Record<string, CommandHandler> = {
  marks: async ({ flags, client, cwd, json }) => {
    const wait = flags.get('wait') === true
    const timeout = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const peek = flags.get('peek') === true
    if (peek && wait) {
      throw new RuntimeClientError('invalid_argument', 'Use --peek or --wait, not both.')
    }
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const response = await client
      .call<CobrowseMarksResult>(
        'browser.marks',
        { wait, timeout, peek, ...target },
        wait
          ? {
              timeoutMs:
                Math.min(timeout ?? COBROWSE_LIMITS.waitDefaultMs, COBROWSE_LIMITS.waitMaxMs) + 5000
            }
          : undefined
      )
      .catch(explainOlderRuntime)
    const { response: shown, paths } = flags.has('save')
      ? saveShots(response)
      : { response, paths: new Map<string, string>() }
    printResult(shown, json, (value) => {
      if (value.marks.length > 0) {
        // The Markdown's marks carry no image data; their screenshots are the saved files.
        return formatCobrowseMarksMarkdown(response.result.marks, paths)
      }
      if (value.pageClosed) {
        return 'No marks: the tab closed before the user sent any.'
      }
      return value.timedOut
        ? 'No marks: the wait ended before the user sent any.'
        : 'No marks waiting. Ask the user to mark something, then run with --wait.'
    })
  },
  point: async ({ flags, client, cwd, json }) => {
    const clear = flags.get('clear') === true
    const element = getOptionalStringFlag(flags, 'element')
    const region = {
      x: getOptionalNumberFlag(flags, 'x'),
      y: getOptionalNumberFlag(flags, 'y'),
      width: getOptionalNumberFlag(flags, 'width'),
      height: getOptionalNumberFlag(flags, 'height')
    }
    if (clear && (element || Object.values(region).some((v) => v !== undefined))) {
      throw new RuntimeClientError('invalid_argument', '--clear takes no element or region.')
    }
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const response = await client
      .call<CobrowsePointResult>('browser.point', {
        ...(clear
          ? { clear: true, pointer: getOptionalStringFlag(flags, 'pointer') }
          : {
              element,
              ...region,
              label: getOptionalStringFlag(flags, 'label'),
              keep: flags.get('keep') === true
            }),
        ...target
      })
      .catch(explainOlderRuntime)
    printResult(response, json, (value) => {
      if (clear) {
        return value.cleared === 1 ? 'Cleared 1 pointer' : `Cleared ${value.cleared} pointers`
      }
      const seen = value.shown
        ? 'the user sees it'
        : 'no Pod pane shows this tab now, so nobody sees it (an older Pod, or the tab is hidden)'
      return `Pointing at ${element ?? 'the region'}: ${seen}`
    })
  }
}
