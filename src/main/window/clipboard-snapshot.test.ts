import { describe, expect, it } from 'vitest'
import {
  clipboardSnapshotImageType,
  rawClipboardFormat,
  snapshotFromClipboardItems,
  type ClipboardItemLike
} from './clipboard-snapshot'

function item(payloads: Record<string, unknown>): ClipboardItemLike {
  return {
    types: Object.keys(payloads),
    getType: async (type) => payloads[type]
  }
}

describe('snapshotFromClipboardItems', () => {
  it('lists each type once and reads a Blob payload as bytes', async () => {
    const snapshot = snapshotFromClipboardItems([
      item({ 'text/plain': new Blob(['hi']), 'image/png': new Blob([new Uint8Array([1, 2])]) }),
      item({ 'text/plain': new Blob(['again']) })
    ])
    expect(snapshot.types).toEqual(['text/plain', 'image/png'])
    await expect(snapshot.readBuffer('text/plain')).resolves.toEqual(Buffer.from('hi'))
    await expect(snapshot.readBuffer('image/png')).resolves.toEqual(Buffer.from([1, 2]))
  })

  it('reads an absent type or a non-Blob payload as empty', async () => {
    const snapshot = snapshotFromClipboardItems([
      item({ 'electron application/bookmark': { title: 'x', url: 'https://x.test' } })
    ])
    await expect(snapshot.readBuffer('electron application/bookmark')).resolves.toEqual(
      Buffer.alloc(0)
    )
    await expect(snapshot.readBuffer(rawClipboardFormat('FileNameW'))).resolves.toEqual(
      Buffer.alloc(0)
    )
  })
})

describe('clipboardSnapshotImageType', () => {
  it('prefers PNG, then any image type, else none', () => {
    const typesOf = (types: string[]) => ({ types, readBuffer: async () => Buffer.alloc(0) })
    expect(clipboardSnapshotImageType(typesOf(['image/jpeg', 'image/png']))).toBe('image/png')
    expect(clipboardSnapshotImageType(typesOf(['text/plain', 'image/jpeg']))).toBe('image/jpeg')
    expect(clipboardSnapshotImageType(typesOf(['text/plain']))).toBeUndefined()
  })
})

describe('rawClipboardFormat', () => {
  it('quotes the platform format name in Electron custom-format syntax', () => {
    expect(rawClipboardFormat('public.file-url')).toBe(
      'electron application/osclipboard;format="public.file-url"'
    )
  })
})
