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

/// Renders a framebuffer surface or a decoded image to a PNG or JPEG file, written beside the
/// target and renamed into place so a reader never sees half a file.
final class ImageWriter: @unchecked Sendable {
    // Built once: a CIContext is expensive to create and safe to share across threads.
    private let context = CIContext(options: [.cacheIntermediates: false])
    // CoreSimulator's own screenshots read framebuffer samples as sRGB (idb v1.7.2 SurfaceImageGenerator).
    private let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    /// Retries once when the seed moved during the read: the surface is live (stage 0 saw 9 of 587
    /// frames change mid-read).
    func write(surface: IOSurfaceRef, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        var result: Result<WrittenImage, HelperError> = .failure(HelperError(.failed, "no read"))
        for _ in 0..<2 {
            let seed = IOSurfaceGetSeed(surface)
            let image = CIImage(ioSurface: surface, options: [.colorSpace: sRGB])
            result = write(image, to: path, options)
            if IOSurfaceGetSeed(surface) == seed { break }
        }
        return result
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
            return .failure(HelperError(.failed, "could not render the framebuffer"))
        }
        return encode(cgImage, to: path, options)
    }

    private func encode(_ image: CGImage, to path: String, _ options: ImageOptions) -> Result<WrittenImage, HelperError> {
        let target = URL(fileURLWithPath: path)
        let temporary = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).\(getpid()).\(UUID().uuidString.prefix(8)).tmp")
        let type = options.format == .png ? UTType.png : UTType.jpeg
        guard let destination = CGImageDestinationCreateWithURL(temporary as CFURL, type.identifier as CFString, 1, nil) else {
            return .failure(HelperError(.writeFailed, "cannot write in \(target.deletingLastPathComponent().path)"))
        }
        let properties: [CFString: Any] = options.format == .jpeg ? [kCGImageDestinationLossyCompressionQuality: options.quality] : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination), rename(temporary.path, target.path) == 0 else {
            let reason = String(cString: strerror(errno))
            try? FileManager.default.removeItem(at: temporary)
            return .failure(HelperError(.writeFailed, "could not write \(path): \(reason)"))
        }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        return .success(WrittenImage(width: image.width, height: image.height, bytes: bytes))
    }
}
