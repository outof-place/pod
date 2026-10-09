/** The part of Electron's W3C `ClipboardItem` a snapshot reads. */
export type ClipboardItemLike = {
  readonly types: readonly string[]
  getType: (type: string) => Promise<unknown>
}

/** One `clipboard.read()`: every type the clipboard offers, each payload fetched on demand. */
export type ClipboardSnapshot = {
  readonly types: readonly string[]
  /** The payload bytes of one type; empty when the clipboard does not carry it. */
  readBuffer: (type: string) => Promise<Buffer>
}

/** Electron 44+ names a platform clipboard format that has no MIME mapping this way. */
export function rawClipboardFormat(format: string): string {
  return `electron application/osclipboard;format="${format}"`
}

export function snapshotFromClipboardItems(items: readonly ClipboardItemLike[]): ClipboardSnapshot {
  return {
    types: [...new Set(items.flatMap((item) => item.types))],
    readBuffer: async (type) => {
      const item = items.find((candidate) => candidate.types.includes(type))
      const payload = item ? await item.getType(type) : null
      return payload instanceof Blob ? Buffer.from(await payload.arrayBuffer()) : Buffer.alloc(0)
    }
  }
}

/** PNG first: Chromium encodes any clipboard bitmap as image/png. */
export function clipboardSnapshotImageType(snapshot: ClipboardSnapshot): string | undefined {
  return snapshot.types.includes('image/png')
    ? 'image/png'
    : snapshot.types.find((type) => type.startsWith('image/'))
}
