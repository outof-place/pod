import { clipboard, ClipboardItem, nativeImage, type NativeImage } from 'electron'
import {
  clipboardSnapshotImageType,
  snapshotFromClipboardItems,
  type ClipboardSnapshot
} from './clipboard-snapshot'

export async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  return snapshotFromClipboardItems(await clipboard.read())
}

/** The clipboard bitmap, empty when it holds none (what Electron 43's readImage() returned). */
export async function readClipboardImage(snapshot?: ClipboardSnapshot): Promise<NativeImage> {
  const contents = snapshot ?? (await readClipboardSnapshot())
  const type = clipboardSnapshotImageType(contents)
  return type
    ? nativeImage.createFromBuffer(await contents.readBuffer(type))
    : nativeImage.createEmpty()
}

export function writeClipboardImage(image: NativeImage): Promise<void> {
  return writeClipboardBuffer('image/png', image.toPNG())
}

export function writeClipboardBuffer(type: string, buffer: Buffer): Promise<void> {
  return clipboard.write([new ClipboardItem({ [type]: new Blob([new Uint8Array(buffer)]) })])
}
