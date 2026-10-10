import Foundation

/// `awake-state.json`, published by the menu helper's Stay Awake (ClaudeAcc's Awake.swift).
public struct AccAwakeState: Decodable, Sendable {
    public let on: Bool
    public let manual: Bool
    public let forever: Bool
    public let hotspot: Bool?
    public let onHotspot: Bool?
    public let autoOnHotspot: Bool?
    public let keepDisplay: Bool?
    public let lidClosed: Bool?
    public let pid: Int?
    /// When a timed manual session ends.
    public let until: Double?
    public let via: String?
    public let updatedAt: Double?
}

/// `pod-services.json`: the SMAppService agents and login item Pod registered for claude-acc.
public struct AccPodServices: Decodable, Sendable {
    public struct Service: Decodable, Identifiable, Sendable {
        public enum Kind: String, Decodable, Sendable {
            case agent
            case loginItem = "login-item"
        }

        /// launchd's view, as Electron reports SMAppService.Status.
        public enum Status: String, Decodable, Sendable {
            case enabled
            case requiresApproval = "requires-approval"
            case notRegistered = "not-registered"
            case notFound = "not-found"
        }

        public let kind: Kind
        public let name: String
        public let status: Status

        public var id: String { name }
    }

    public let version: Int
    public let at: String
    public let app: String
    public let payload: String?
    public let services: [Service]

    /// Services the user switched off in System Settings → Login Items.
    public var needsApproval: [Service] { services.filter { $0.status == .requiresApproval } }
}

/// `owner.json` (claude-acc's owner.py): which installer owns this account's claude-acc.
public struct AccOwner: Decodable, Sendable {
    public let owner: String
    public let version: String?
    public let app: String?
    public let at: Double?

    public var isPod: Bool { owner == "pod" }
}
