import { fileURLToPath } from 'node:url'
import { rawClipboardFormat, type ClipboardSnapshot } from './clipboard-snapshot'
import { readWindowsCopiedFilePath } from './clipboard-windows-image-file'

type ClipboardFormatReader = Pick<ClipboardSnapshot, 'readBuffer'>

const FILE_LIST_MAX_BYTES = 256 * 1024
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"'
}

async function readBoundedText(clipboard: ClipboardFormatReader, type: string): Promise<string> {
  const buffer = await clipboard.readBuffer(type)
  return buffer.byteLength <= FILE_LIST_MAX_BYTES ? buffer.toString('utf8') : ''
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|apos|gt|lt|quot));/g,
    (_entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) =>
      decimal
        ? String.fromCodePoint(Number(decimal))
        : hex
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : XML_ENTITIES[name ?? '']
  )
}

/** File URLs; any other entry means this is not a file copy. */
function filePathsFromUrls(urls: readonly string[], windows = false): string[] {
  const paths: string[] = []
  for (const url of urls) {
    // Finder can hand out file-reference URLs (/.file/id=…), which name no file.
    if (!url.startsWith('file://') || url.startsWith('file:///.file/id=')) {
      return []
    }
    paths.push(fileURLToPath(url, { windows }))
  }
  return paths
}

// Electron maps text/uri-list to each OS's file list (NSFilenamesPboardType, CF_HDROP).
async function readUriListFilePaths(
  clipboard: ClipboardFormatReader,
  windows = false
): Promise<string[]> {
  const urls = (await readBoundedText(clipboard, 'text/uri-list'))
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return filePathsFromUrls(urls, windows)
}

async function readMacCopiedFilePaths(clipboard: ClipboardFormatReader): Promise<string[]> {
  const fromUriList = await readUriListFilePaths(clipboard)
  if (fromUriList.length > 0) {
    return fromUriList
  }
  // Finder's legacy filenames plist lists every copied file; public.file-url holds only the first.
  const plist = await readBoundedText(clipboard, rawClipboardFormat('NSFilenamesPboardType'))
  const listed = Array.from(plist.matchAll(/<string>([^<]*)<\/string>/g), (match) =>
    decodeXmlText(match[1])
  )
  if (listed.length > 0) {
    return listed
  }
  const url = (await readBoundedText(clipboard, rawClipboardFormat('public.file-url'))).trim()
  return url ? filePathsFromUrls([url]) : []
}

async function readWindowsCopiedFilePaths(clipboard: ClipboardFormatReader): Promise<string[]> {
  const filePath = readWindowsCopiedFilePath({
    fileNameW: await clipboard.readBuffer(rawClipboardFormat('FileNameW')),
    shellIdListArray: await clipboard.readBuffer(rawClipboardFormat('Shell IDList Array'))
  })
  return filePath ? [filePath] : []
}

/**
 * Paths of the files a file manager copied, so a paste can tell the text that
 * labels them from prompt text. A list it cannot read in full comes back empty.
 */
export async function readClipboardCopiedFilePaths(
  clipboard: ClipboardFormatReader,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  try {
    if (platform === 'darwin') {
      return await readMacCopiedFilePaths(clipboard)
    }
    if (platform === 'win32') {
      return await readWindowsCopiedFilePaths(clipboard)
    }
    return await readUriListFilePaths(clipboard)
  } catch {
    return []
  }
}
