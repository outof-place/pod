import Foundation

// `status.json` / `claude-acc status --json` (accswitch.py). The script owns all account logic;
// these types only carry what it decided. Ported from ClaudeAcc's Model.swift.

/// The IDE that holds the Claude accounts and runs the agents (orcahost.py): Orca, or Pod.
public struct AccHostApp: Decodable, Equatable, Sendable {
    public let name: String
    public let bundleId: String

    public static let orca = AccHostApp(name: "Orca", bundleId: "com.stablyai.orca")

    public init(name: String, bundleId: String) {
        self.name = name
        self.bundleId = bundleId
    }
}

public struct AccSnapshot: Decodable, Sendable {
    public let generatedAt: Double
    public let activeEmail: String?
    public let foreignRuntime: Bool
    public let thresholds: AccThresholds
    public let forecast: AccForecast?
    public let apiBackoffUntil: Double?
    public let lastTick: Double?
    public let switchedAt: Double?
    /// The account selected in the host's own menu: auto-switch then stands still.
    public let orcaSelected: String?
    /// Missing from scripts before 1.26, which means Orca.
    public let host: AccHostApp?
    /// The limit pause: no account has headroom, so sessions wind down to a checkpoint.
    public let pause: AccPause?
    /// `claude-acc pause on|off`; missing before 1.10.
    public let limitPause: Bool?
    /// `claude-acc drain on|off`; missing before 1.12.
    public let drain: Bool?
    public let credits: AccCreditsSummary?
    public let accounts: [AccAccount]

    public var active: AccAccount? { accounts.first { $0.active } }
    public var others: [AccAccount] { accounts.filter { !$0.active } }
    /// The account auto-switch moves to next.
    public var next: AccAccount? {
        others.compactMap { account in account.queue.map { (account, $0) } }.min { $0.1 < $1.1 }?.0
    }
    public var anyNeedsLogin: Bool { accounts.contains { $0.status == .needsLogin } }
}

/// Monthly API credits of the Max plans, pooled across their Console organizations.
public struct AccCreditsSummary: Decodable, Sendable {
    public let totalRemainingUsd: Double
    public let grantedUsd: Double
    public let linked: Int
    public let pending: Int
    public let error: Int
    public let byScope: [String: Double]
    public let nextExpiryAt: Double?
    public let nextExpiryUsd: Double?
    public let checkedAt: Double?

    public var spentFraction: Double {
        grantedUsd > 0 ? max(0, min(1, 1 - totalRemainingUsd / grantedUsd)) : 0
    }
}

public struct AccPause: Decodable, Sendable {
    public let since: Double
    public let account: String
    public let resumeAt: Double?
}

public struct AccThresholds: Decodable, Sendable {
    public let sessionLeft: Double
    public let weeklyLeft: Double
}

public struct AccForecast: Decodable, Sendable {
    public let session: AccWindowForecast?
    public let weekly: AccWindowForecast?
}

public struct AccWindowForecast: Decodable, Sendable {
    public let rate: Double
    public let atReset: Double
    public let switchAt: Double?
}

public struct AccUsageWindow: Decodable, Sendable {
    public let used: Double?
    public let resetsAt: Double?
}

public struct AccAccount: Decodable, Identifiable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case ok
        case needsLogin = "needs_login"
        case error
    }

    public let id: String
    public let email: String
    public let realEmail: String?
    public let tier: String
    public let active: Bool
    public let lastResort: Bool
    public let status: Status
    public let note: String
    public let usable: Bool
    public let queue: Int?
    public let session: AccUsageWindow?
    public let weekly: AccUsageWindow?
    public let dataAge: Int?
    /// A full window keeps the numbers exact until this reset.
    public let fullUntil: Double?
    public let renewsAt: Double?
    public let subscriptionStatus: String?
    public let subscriptionSince: String?

    /// Old numbers that could have changed since: a full account's numbers can't.
    public var dataStale: Bool { (dataAge ?? 0) > 900 && fullUntil == nil }
    /// A host entry can hold a different account than its label says.
    public var mislabeled: Bool { realEmail.map { $0.lowercased() != email.lowercased() } ?? false }
    /// The most used window: the one that stops work first.
    public var worstUsed: Double? { [session?.used, weekly?.used].compactMap(\.self).max() }
}
