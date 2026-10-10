import Foundation

// `devguard-state.json` (devguard.py): memory, the dev servers per worktree, and what the guard
// did about them. Ported from ClaudeAcc's Model.swift.

public struct AccGuardState: Decodable, Sendable {
    public let snapshot: AccGuardSnapshot?
    public let events: [AccGuardEvent]?
    /// `[time, dev servers, swap, compressed]` every 30 seconds, two hours back.
    public let history: [[Double]]?
}

public struct AccGuardSnapshot: Decodable, Sendable {
    public let at: Double
    public let mode: String
    public let pressure: AccMemoryPressure
    public let budget: Double
    public let total: Double
    /// Whether the host IDE's bridge was reachable (the key predates Pod).
    public let orca: Bool
    public let units: [AccGuardUnit]
    public let plans: [AccGuardPlan]

    public func plan(for unit: AccGuardUnit) -> AccGuardPlan? { plans.first { $0.unit == unit.key } }
}

public struct AccMemoryPressure: Decodable, Sendable {
    public let level: Int
    public let notes: [String]?
    public let available: Int?
    public let swapUsed: Double
    public let swapTotal: Double
    public let swapping: Bool
    public let compressed: Double
    public let ram: Double
}

/// A command and the dev servers it started: one `next dev`, or a whole `pnpm dev` stack.
public struct AccGuardUnit: Decodable, Identifiable, Sendable {
    public struct Client: Decodable, Sendable {
        public let pid: Int
        public let kind: String
        public let name: String
    }

    public struct Tab: Decodable, Sendable {
        public let url: String?
        public let focused: Bool?
    }

    public let key: String
    public let root: Int
    public let ports: [Int]
    public let kinds: [String]
    public let cwd: [String]
    public let footprint: Double
    public let peak: Double
    public let host: String
    public let command: String?
    public let terminal: String?
    public let clients: [Client]
    public let tabs: [Tab]
    public let attended: Bool
    public let agentWorking: Bool
    public let recyclable: Bool
    public let quiet: Int
    public let protected: Bool
    public let background: Bool?
    public let servers: Int?
    public let launchCwd: String?

    public var id: String { key }
    public var isStack: Bool { (servers ?? 1) > 1 }

    /// The worktree it runs in: `…/portivo-landing-spacing/apps/landing-page` → `portivo-landing-spacing`.
    public var place: String {
        let path = isStack ? (launchCwd ?? cwd.first ?? "") : (cwd.first ?? "")
        let parts = path.split(separator: "/").map(String.init)
        if let apps = parts.lastIndex(where: { $0 == "apps" || $0 == "packages" }), apps > 0 {
            return parts[apps - 1]
        }
        return isStack ? (parts.last ?? path) : (parts.dropLast().last ?? path)
    }

    /// What `devguard.py stop|recycle` takes: its first port, else the root pid.
    public var target: String { ports.first.map { ":\($0)" } ?? String(root) }
}

/// The numbers behind a decision; the script's own sentence stays in its log.
public struct AccGuardReason: Decodable, Sendable {
    public let keep: Int?
    public let minutes: Int?
    public let size: Double?
    public let limit: Double?
    public let level: Int?
    public let total: Double?
    public let budget: Double?
    public let restarts: Int?
}

public struct AccGuardPlan: Decodable, Sendable {
    public let unit: String
    public let action: String
    public let code: String?
    public let data: AccGuardReason?
}

public struct AccGuardEvent: Decodable, Identifiable, Sendable {
    public let at: Double
    public let action: String
    public let label: String
    public let size: Double?
    public let code: String?
    public let data: AccGuardReason?
    public let ports: [Int]?
    public let ok: Bool

    public var id: Double { at }
}
