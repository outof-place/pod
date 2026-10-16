import Foundation

/// The running macOS as SystemVersion.plist names it, read without loading anything.
public struct MacOSInfo: Codable, Equatable, Sendable {
    public let version: String
    public let build: String

    static let accessibilityTranslationPath = "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework"

    static func running(plist: String = "/System/Library/CoreServices/SystemVersion.plist") -> MacOSInfo? {
        guard let info = NSDictionary(contentsOfFile: plist),
              let version = info["ProductVersion"] as? String, let build = info["ProductBuildVersion"] as? String
        else { return nil }
        return MacOSInfo(version: version, build: build)
    }
}
