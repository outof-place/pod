import { clipboardFormatsIncludeImage } from '../../shared/clipboard-image'
import { rawClipboardFormat, type ClipboardSnapshot } from './clipboard-snapshot'
import {
  readWindowsCopiedImageFilePath,
  type WindowsClipboardFileFormats
} from './clipboard-windows-image-file'

type ClipboardImageReader = Pick<ClipboardSnapshot, 'types' | 'readBuffer'>

type ClipboardImageSource =
  | { kind: 'native'; windowsFileFormats: WindowsClipboardFileFormats | null }
  | { kind: 'windows-file'; windowsFileFormats: WindowsClipboardFileFormats }

/** Select image sources without decoding pixels or reading a copied file. */
export async function readClipboardImageSource(
  clipboard: ClipboardImageReader,
  platform: NodeJS.Platform = process.platform
): Promise<ClipboardImageSource | null> {
  const formats =
    platform === 'win32'
      ? {
          fileNameW: await clipboard.readBuffer(rawClipboardFormat('FileNameW')),
          shellIdListArray: await clipboard.readBuffer(rawClipboardFormat('Shell IDList Array'))
        }
      : null
  const windowsFileFormats = formats && readWindowsCopiedImageFilePath(formats) ? formats : null
  if (clipboardFormatsIncludeImage(clipboard.types)) {
    return { kind: 'native', windowsFileFormats }
  }
  return windowsFileFormats ? { kind: 'windows-file', windowsFileFormats } : null
}
