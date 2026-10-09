import { describe, expect, it, vi } from 'vitest'
import { readClipboardImageSource } from './clipboard-image-source'
import { rawClipboardFormat } from './clipboard-snapshot'

const FILE_NAME_W = rawClipboardFormat('FileNameW')
const SHELL_ID_LIST_ARRAY = rawClipboardFormat('Shell IDList Array')

function clipboardReader(filePath = '', itemCount = 1, types: string[] = [FILE_NAME_W]) {
  const shellItems = Buffer.alloc(4 + 4 * (itemCount + 1))
  shellItems.writeUInt32LE(itemCount)
  const buffers: Record<string, Buffer> = {
    [FILE_NAME_W]: Buffer.from(`${filePath}\0`, 'utf16le'),
    [SHELL_ID_LIST_ARRAY]: shellItems
  }
  return {
    types,
    readBuffer: vi.fn(async (type: string) => buffers[type] ?? Buffer.alloc(0))
  }
}

describe('readClipboardImageSource', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'recognizes native image formats on %s without decoding',
    async (platform) => {
      const clipboard = clipboardReader('', 1, ['text/plain', 'image/png'])
      await expect(readClipboardImageSource(clipboard, platform)).resolves.toEqual({
        kind: 'native',
        windowsFileFormats: null
      })
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'ignores ordinary text on %s',
    async (platform) => {
      await expect(
        readClipboardImageSource(clipboardReader('', 1, ['text/plain']), platform)
      ).resolves.toBeNull()
    }
  )

  it.each([
    'C:\\Users\\alice\\图片\\shot.PNG',
    '\\\\server\\share\\shot.jpeg',
    '\\\\?\\C:\\Users\\alice\\shot.jpg',
    '\\\\?\\UNC\\server\\share\\shot.png'
  ])('recognizes a supported single Windows image file: %s', async (filePath) => {
    const clipboard = clipboardReader(filePath)
    const source = await readClipboardImageSource(clipboard, 'win32')
    expect(source?.kind).toBe('windows-file')
    expect(source?.windowsFileFormats).toEqual({
      fileNameW: await clipboard.readBuffer(FILE_NAME_W),
      shellIdListArray: await clipboard.readBuffer(SHELL_ID_LIST_ARRAY)
    })
  })

  it.each([
    ['C:\\shot.pdf', 1],
    ['C:\\shot.webp', 1],
    ['C:\\shot.png', 2],
    ['shot.png', 1],
    ['C:shot.png', 1],
    ['\\\\server\\pipe\\shot.png', 1],
    ['C:\\one.png\0C:\\two.png', 1]
  ])('rejects an unsupported file source: %s (%s items)', async (filePath, itemCount) => {
    await expect(
      readClipboardImageSource(clipboardReader(filePath, itemCount), 'win32')
    ).resolves.toBeNull()
  })

  it.each(['darwin', 'linux'] as const)(
    'never reads Windows file formats on %s',
    async (platform) => {
      const clipboard = clipboardReader('C:\\shot.png')
      await expect(readClipboardImageSource(clipboard, platform)).resolves.toBeNull()
      expect(clipboard.readBuffer).not.toHaveBeenCalled()
    }
  )

  it('keeps the copied-file fallback beside advertised native image data', async () => {
    const clipboard = clipboardReader('C:\\shot.png', 1, ['image/png', FILE_NAME_W])
    const source = await readClipboardImageSource(clipboard, 'win32')
    expect(source?.kind).toBe('native')
    expect(source?.windowsFileFormats?.fileNameW).toEqual(await clipboard.readBuffer(FILE_NAME_W))
  })
})
