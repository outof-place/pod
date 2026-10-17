import Accelerate
import CPodSimSurface
import CoreImage
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

public enum ImageFormat: String, Codable, Sendable {
    case png, jpeg
}

public struct ImageOptions: Sendable {
    public let format: ImageFormat
    /// 0 < scale <= 1 of the framebuffer's pixels.
    public let scale: Double
    /// JPEG quality, 0 < quality <= 1.
    public let quality: Double
}

struct WrittenImage: Sendable {
    let width: Int
    let height: Int
    let bytes: Int
}

/// A framebuffer's pixels, copied out while its seed held still. 4 bytes per pixel, BGRA, top row first.
final class PixelCopy {
    /// 'BGRA', CoreSimulator's framebuffer format (stage 0): the only one the encoders read right.
    static let pixelFormat: OSType = 0x4247_5241

    let width: Int
    let height: Int
    let stride: Int
    let pixels: UnsafeMutableRawPointer

    init(width: Int, height: Int, stride: Int) {
        self.width = width
        self.height = height
        self.stride = stride
        pixels = UnsafeMutableRawPointer.allocate(byteCount: max(1, stride * height), alignment: 64)
    }

    deinit { pixels.deallocate() }

    /// The surface's pixels as of one seed. The device rewrites the surface in place, so a copy whose
    /// seed moved meanwhile is taken again (stage 0 saw 9 of 587 reads change mid-read); a copy takes
    /// about a millisecond, a frame comes every 16. nil for any format but single-plane BGRA.
    static func of(_ surface: IOSurfaceRef, attempts: Int = 3) -> PixelCopy? {
        guard IOSurfaceGetPixelFormat(surface) == pixelFormat, IOSurfaceGetBytesPerElement(surface) == 4,
              IOSurfaceGetPlaneCount(surface) <= 1
        else { return nil }
        let copy = PixelCopy(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), stride: IOSurfaceGetBytesPerRow(surface))
        for _ in 0..<attempts {
            var before: UInt32 = 0
            guard IOSurfaceLock(surface, .readOnly, &before) == kIOReturnSuccess else { return nil }
            memcpy(copy.pixels, IOSurfaceGetBaseAddress(surface), copy.stride * copy.height)
            IOSurfaceUnlock(surface, .readOnly, nil)
            if IOSurfaceGetSeed(surface) == before { break }
        }
        return copy
    }

    /// Resampled to `width` x `height` (vImage's default Lanczos kernel).
    func scaled(width: Int, height: Int) -> PixelCopy? {
        let out = PixelCopy(width: width, height: height, stride: width * 4)
        var source = vImage_Buffer(data: pixels, height: vImagePixelCount(self.height), width: vImagePixelCount(self.width), rowBytes: stride)
        var target = vImage_Buffer(data: out.pixels, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: out.stride)
        return vImageScale_ARGB8888(&source, &target, nil, vImage_Flags(kvImageNoFlags)) == kvImageNoError ? out : nil
    }
}

/// Writes a framebuffer or a decoded image as PNG or JPEG, beside the target and renamed into place so
/// a reader never sees half a file. From a framebuffer: one seed-stable copy, then PNG through
/// pod_sim_png_encode (strips in parallel) or JPEG through ImageIO, no Core Image in between.
final class ImageWriter: @unchecked Sendable {
    // For decoded images (the simctl fallback): built once, a CIContext is expensive to create.
    private let context = CIContext(options: [.cacheIntermediates: false])
    // CoreSimulator's own screenshots read framebuffer samples as sRGB (idb v1.7.2 SurfaceImageGenerator).
    private let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    func write(surface: IOSurfaceRef, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        guard let copy = PixelCopy.of(surface) else {
            let format = IOSurfaceGetPixelFormat(surface)
            return .failure(HelperError(.failed, "the framebuffer is not BGRA (pixel format \(String(format: "0x%08x", format))) or did not lock"))
        }
        let width = max(1, Int((Double(copy.width) * options.scale).rounded()))
        let height = max(1, Int((Double(copy.height) * options.scale).rounded()))
        guard let image = width == copy.width && height == copy.height ? copy : copy.scaled(width: width, height: height) else {
            return .failure(HelperError(.internal, "scaling the framebuffer failed"))
        }
        switch options.format {
        case .png:
            var bytes: UnsafeMutablePointer<UInt8>?
            var size = 0
            guard pod_sim_png_encode(image.pixels.assumingMemoryBound(to: UInt8.self), image.width, image.height, image.stride, &bytes, &size) == 0,
                  let bytes
            else { return .failure(HelperError(.internal, "PNG encoding failed")) }
            defer { free(bytes) }
            return place(Data(bytesNoCopy: bytes, count: size, deallocator: .none), at: path).map {
                WrittenImage(width: image.width, height: image.height, bytes: size)
            }
        case .jpeg:
            let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            guard let provider = CGDataProvider(dataInfo: nil, data: image.pixels, size: image.stride * image.height, releaseData: { _, _, _ in }),
                  let cgImage = CGImage(
                      width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: image.stride,
                      space: sRGB, bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
            else { return .failure(HelperError(.internal, "could not wrap the framebuffer copy")) }
            // `image` owns the pixels the provider points at until the encoder is done.
            return withExtendedLifetime(image) { encode(cgImage, to: path, options) }
        }
    }

    func write(contentsOf source: URL, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        guard let image = CIImage(contentsOf: source) else {
            return .failure(HelperError(.failed, "could not read \(source.path)"))
        }
        return write(image, to: path, options)
    }

    private func write(_ source: CIImage, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        let extent = source.extent.integral
        let width = max(1, Int((extent.width * options.scale).rounded()))
        let height = max(1, Int((extent.height * options.scale).rounded()))
        var image = source.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
        if width != Int(extent.width) || height != Int(extent.height) {
            guard let filter = CIFilter(name: "CILanczosScaleTransform") else {
                return .failure(HelperError(.internal, "CILanczosScaleTransform is missing"))
            }
            let yScale = Double(height) / extent.height
            filter.setValue(image, forKey: kCIInputImageKey)
            filter.setValue(yScale, forKey: kCIInputScaleKey)
            filter.setValue((Double(width) / extent.width) / yScale, forKey: kCIInputAspectRatioKey)
            guard let scaled = filter.outputImage else { return .failure(HelperError(.internal, "scaling failed")) }
            image = scaled
        }
        guard let cgImage = context.createCGImage(image, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8, colorSpace: sRGB) else {
            return .failure(HelperError(.failed, "could not render the image"))
        }
        return encode(cgImage, to: path, options)
    }

    private func encode(_ image: CGImage, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        let data = NSMutableData()
        let type = options.format == .png ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            return .failure(HelperError(.internal, "ImageIO has no \(type.identifier) encoder"))
        }
        let properties: [CFString: Any] = options.format == .jpeg ? [kCGImageDestinationLossyCompressionQuality: options.quality] : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return .failure(HelperError(.internal, "encoding the image failed")) }
        return place(data as Data, at: path).map { WrittenImage(width: image.width, height: image.height, bytes: data.length) }
    }

    /// Writes beside the target, then renames it into place.
    private func place(_ data: Data, at path: String) -> Result<Void, HelperError> {
        let target = URL(fileURLWithPath: path)
        let temporary = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).\(getpid()).\(UUID().uuidString.prefix(8)).tmp")
        do {
            try data.write(to: temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            return .failure(HelperError(.writeFailed, "cannot write in \(target.deletingLastPathComponent().path): \(error.localizedDescription)"))
        }
        guard rename(temporary.path, target.path) == 0 else {
            let reason = String(cString: strerror(errno))
            try? FileManager.default.removeItem(at: temporary)
            return .failure(HelperError(.writeFailed, "could not write \(path): \(reason)"))
        }
        return .success(())
    }
}
