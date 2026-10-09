import { describe, expect, it } from 'vitest'
import { readClipboardCopiedFilePaths } from './clipboard-copied-file-paths'
import { rawClipboardFormat } from './clipboard-snapshot'

function clipboardWith(formats: Record<string, Buffer | string>) {
  return {
    readBuffer: async (type: string): Promise<Buffer> => {
      const value = formats[type]
      return typeof value === 'string' ? Buffer.from(value, 'utf8') : (value ?? Buffer.alloc(0))
    }
  }
}

function filenamesPlist(paths: string[]): string {
  const entries = paths.map((path) => `<string>${path}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${entries}</array></plist>`
}

describe('readClipboardCopiedFilePaths', () => {
  it('lists every file Finder copied from the uri-list Electron maps NSFilenamesPboardType to', async () => {
    const clipboard = clipboardWith({
      'text/uri-list': 'file:///Users/me/Q&A%20shot.png\r\nfile:///Users/me/b.pdf\r\n',
      [rawClipboardFormat('NSFilenamesPboardType')]: filenamesPlist(['/Users/me/stale.png'])
    })
    await expect(readClipboardCopiedFilePaths(clipboard, 'darwin')).resolves.toEqual([
      '/Users/me/Q&A shot.png',
      '/Users/me/b.pdf'
    ])
  })

  it('falls back to the raw Finder filenames plist, decoding XML entities', async () => {
    const clipboard = clipboardWith({
      [rawClipboardFormat('NSFilenamesPboardType')]: filenamesPlist([
        '/Users/me/Q&amp;A shot.png',
        '/Users/me/b.pdf'
      ]),
      [rawClipboardFormat('public.file-url')]: 'file:///Users/me/Q&A%20shot.png'
    })
    await expect(readClipboardCopiedFilePaths(clipboard, 'darwin')).resolves.toEqual([
      '/Users/me/Q&A shot.png',
      '/Users/me/b.pdf'
    ])
  })

  it('falls back to the first file URL on macOS, but not a file-reference URL', async () => {
    await expect(
      readClipboardCopiedFilePaths(
        clipboardWith({
          [rawClipboardFormat('public.file-url')]: 'file:///Users/me/my%20shot.png'
        }),
        'darwin'
      )
    ).resolves.toEqual(['/Users/me/my shot.png'])
    await expect(
      readClipboardCopiedFilePaths(
        clipboardWith({
          [rawClipboardFormat('public.file-url')]: 'file:///.file/id=6571367.2773272'
        }),
        'darwin'
      )
    ).resolves.toEqual([])
  })

  it('reads a Linux file manager uri-list and rejects non-file entries', async () => {
    await expect(
      readClipboardCopiedFilePaths(
        clipboardWith({
          'text/uri-list': '# copied\r\nfile:///home/me/a.png\r\nfile:///home/me/b%20c.txt\r\n'
        }),
        'linux'
      )
    ).resolves.toEqual(['/home/me/a.png', '/home/me/b c.txt'])
    await expect(
      readClipboardCopiedFilePaths(
        clipboardWith({ 'text/uri-list': 'file:///home/me/a.png\nhttps://example.com/x' }),
        'linux'
      )
    ).resolves.toEqual([])
  })

  it('reads the single file Explorer copied and nothing when it copied several', async () => {
    const shellItems = (count: number): Buffer => {
      const cida = Buffer.alloc(4 + 4 * (count + 1))
      cida.writeUInt32LE(count)
      return cida
    }
    const explorer = (count: number) =>
      clipboardWith({
        [rawClipboardFormat('FileNameW')]: Buffer.from('C:\\Users\\me\\shot.png\0', 'utf16le'),
        [rawClipboardFormat('Shell IDList Array')]: shellItems(count)
      })
    await expect(readClipboardCopiedFilePaths(explorer(1), 'win32')).resolves.toEqual([
      'C:\\Users\\me\\shot.png'
    ])
    await expect(readClipboardCopiedFilePaths(explorer(2), 'win32')).resolves.toEqual([])
  })

  it('returns nothing for plain text, oversized lists, or a failing clipboard', async () => {
    await expect(readClipboardCopiedFilePaths(clipboardWith({}), 'darwin')).resolves.toEqual([])
    const huge = filenamesPlist(['/a'.padEnd(300 * 1024, 'a')])
    await expect(
      readClipboardCopiedFilePaths(
        clipboardWith({ [rawClipboardFormat('NSFilenamesPboardType')]: huge }),
        'darwin'
      )
    ).resolves.toEqual([])
    const failing = {
      readBuffer: async (): Promise<Buffer> => {
        throw new Error('format unavailable')
      }
    }
    await expect(readClipboardCopiedFilePaths(failing, 'linux')).resolves.toEqual([])
  })
})
