// Fork-only (Pod): co-browse. The user marks elements of a Pod browser pane for the agent working the
// tab, the agent points at elements for the user. The runtime that hosts the page owns both.

/** CSS px in the page's viewport (the space browserInput uses), or the document's for `pageBox`. */
export type CobrowseBox = { x: number; y: number; width: number; height: number }

/** What a mark or pointer is on, as an agent addresses it. */
export type CobrowseElement = {
  tag: string
  /** Unique when the mark was made; agent-browser takes it as is (`click --element "<selector>"`). */
  selector: string
  /** The accessibility role and name agent-browser's snapshot prints (`button "Save"`). */
  role: string | null
  name: string | null
  text: string
  /** outerHTML, scripts left out, cut to COBROWSE_LIMITS.html. */
  html: string
  /** The frame's URL when the element sits in an iframe. */
  frameUrl: string | null
}

export type CobrowseMarkState = 'draft' | 'sent' | 'taken'

export type CobrowseScreenshot = {
  mimeType: 'image/png'
  data: string
  width: number
  height: number
}

/** A mark as the agent gets it (`browser.marks`). */
export type CobrowseMark = {
  id: string
  /** Its number on the pane, 1 up. */
  n: number
  browserPageId: string
  url: string
  title: string
  note: string
  createdAt: string
  kind: 'element' | 'region'
  /** Null for a region over nothing addressable. */
  element: CobrowseElement | null
  box: CobrowseBox
  pageBox: CobrowseBox
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  /** The agent's pointers on the page when the user made it: what the user answers. */
  replyTo: { pointerId: string; label: string }[]
  screenshot: CobrowseScreenshot | null
}

export type CobrowseMarksResult = {
  browserPageId: string
  marks: CobrowseMark[]
  /** The wait ended with nothing sent. */
  timedOut: boolean
  /** With peek: the marks as Markdown, as `marks` prints them. */
  markdown?: string
}

export type CobrowsePointResult = {
  browserPageId: string
  pointerId: string | null
  box: CobrowseBox | null
  /** A pane that draws pointers shows the page now; false on an older PodNative or a hidden tab. */
  shown: boolean
  cleared: number
}

export const COBROWSE_LIMITS = {
  marksPerPage: 20,
  pointersPerPage: 5,
  note: 2000,
  label: 120,
  text: 200,
  html: 2048,
  selector: 700,
  screenshotBytes: 2 * 1024 * 1024,
  /** marks --wait: default and ceiling, ms. */
  waitDefaultMs: 10 * 60_000,
  waitMaxMs: 60 * 60_000
} as const

function inline(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function fence(content: string, language: string): string {
  let longest = 2
  for (const run of content.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length)
  }
  const marker = '`'.repeat(longest + 1)
  return `${marker}${language}\n${content}\n${marker}`
}

function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

function round(box: CobrowseBox): string {
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
}

/** What the mark is on, in one line: `button "Save"`, else the tag and its text. */
export function cobrowseElementLabel(element: CobrowseElement | null): string {
  if (!element) {
    return 'region'
  }
  const what = element.role && element.role !== 'generic' ? element.role : element.tag
  const name = element.name || element.text
  return name ? `${what} "${inline(name, 60)}"` : what
}

/**
 * Marks as a bug report an agent acts on: the note first, then where it is and how to reach it.
 * `screenshotPaths` maps a mark id to the file its screenshot was saved to.
 */
export function formatCobrowseMarksMarkdown(
  marks: readonly CobrowseMark[],
  screenshotPaths: ReadonlyMap<string, string> = new Map()
): string {
  if (marks.length === 0) {
    return ''
  }
  const lines: string[] = []
  const first = marks[0]
  lines.push(`# ${marks.length === 1 ? 'A mark' : `${marks.length} marks`} on ${first.url}`)
  for (const mark of marks) {
    lines.push('')
    const note = mark.note.trim() ? inline(mark.note, 2000) : '(no note)'
    lines.push(`## ${mark.n}. ${note}`)
    lines.push('')
    lines.push(
      `- On: ${cobrowseElementLabel(mark.element)}${mark.kind === 'region' ? ' (a region)' : ''}`
    )
    if (mark.url !== first.url) {
      lines.push(`- Page: ${mark.url}`)
    }
    if (mark.element) {
      lines.push(`- Locator: ${code(mark.element.selector)}`)
      if (mark.element.role && mark.element.name) {
        lines.push(`- Role and name: ${mark.element.role} ${code(inline(mark.element.name, 120))}`)
      }
      if (mark.element.frameUrl) {
        lines.push(`- In the iframe ${mark.element.frameUrl}`)
      }
      if (mark.element.text && mark.element.text !== mark.element.name) {
        lines.push(`- Text: ${inline(mark.element.text, 200)}`)
      }
    }
    lines.push(
      `- Box: ${round(mark.box)} in a ${mark.viewport.width}x${mark.viewport.height} viewport, scrolled to ${Math.round(mark.viewport.scrollX)},${Math.round(mark.viewport.scrollY)}`
    )
    for (const pointer of mark.replyTo) {
      lines.push(`- In reply to your pointer: ${inline(pointer.label, 120) || pointer.pointerId}`)
    }
    const shot = screenshotPaths.get(mark.id)
    if (shot) {
      lines.push(`- Screenshot: ${shot}`)
    }
    if (mark.element?.html) {
      lines.push('')
      lines.push(fence(mark.element.html, 'html'))
    }
  }
  return lines.join('\n')
}
