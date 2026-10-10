import Foundation

// `sched/state.json` (sched.py; contract in claude-acc's docs/sched.md): the memory scheduler's
// running and queued builds and tests. Ported from ClaudeAcc's BuildsViews.swift.

public struct AccSchedState: Decodable, Sendable {
    public struct Host: Decodable, Sendable {
        public let ramGb: Double?
    }

    public struct Config: Decodable, Sendable {
        public let headroomGb: Double?
    }

    public struct Memory: Decodable, Sendable {
        public let levelPct: Double?
        public let availableGb: Double?
        public let headroomGb: Double?
        public let devserverReserveGb: Double?
        public let jobsNowGb: Double?
        public let reservedGb: Double?
        public let othersGb: Double?
        public let freeForAdmissionGb: Double?
        public let idleMaxGb: Double?
        public let swapUsedGb: Double?
        public let pressure: String?
    }

    public struct Agent: Decodable, Sendable {
        public let name: String?
        public let worktree: String?
    }

    public struct Route: Decodable, Sendable {
        public let choice: String?
        public let why: String?
        public let text: String?
        public let costUsd: Double?
    }

    public struct Depot: Decodable, Sendable {
        public let target: String?
        public let job: String?
        public let cores: Int?
        public let runId: String?
        public let url: String?
        public let costUsd: Double?
    }

    public struct Reason: Decodable, Sendable {
        public let code: String?
        public let needGb: Double?
        public let freeGb: Double?
        public let text: String?
    }

    public struct Job: Decodable, Identifiable, Sendable {
        public let id: String
        public let kind: String?
        public let label: String
        public let repo: String?
        public let agent: Agent?
        public let `where`: String?
        public let route: Route?
        public let p: Int?
        public let memPredictedGb: Double?
        public let count1Dropped: Bool?
        public let elapsedS: Double?
        public let etaS: Double?
        public let progress: Double?
        public let memNowGb: Double?
        public let paused: Bool?
        public let pauseReason: String?
        /// Seconds without CPU and without output; nil while the job works.
        public let stalledS: Double?
        public let depot: Depot?
        public let position: Int?
        public let waitedS: Double?
        public let etaStartS: Double?
        public let reason: Reason?

        public var onDepot: Bool { self.where == "depot" }
    }

    public struct Recent: Decodable, Identifiable, Sendable {
        public let id: String
        public let label: String
        public let `where`: String?
        public let rc: Int?
        public let finishedAt: Double?
        public let wallS: Double?
        public let peakGb: Double?
        public let costUsd: Double?
        public let routeText: String?
        public let url: String?
    }

    public struct Today: Decodable, Sendable {
        public let jobsLocal: Int?
        public let jobsDepot: Int?
        public let waitSavedS: Double?
        public let depotCostUsd: Double?
        public let localKeptUsd: Double?
        public let overtakes: Int?
    }

    public let updatedAt: Double?
    public let idleSince: Double?
    public let host: Host?
    public let config: Config?
    public let memory: Memory?
    public let running: [Job]
    public let queue: [Job]
    public let recent: [Recent]
    public let today: Today?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt)
        idleSince = try c.decodeIfPresent(Double.self, forKey: .idleSince)
        host = try c.decodeIfPresent(Host.self, forKey: .host)
        config = try c.decodeIfPresent(Config.self, forKey: .config)
        memory = try c.decodeIfPresent(Memory.self, forKey: .memory)
        running = try c.decodeIfPresent([Job].self, forKey: .running) ?? []
        queue = try c.decodeIfPresent([Job].self, forKey: .queue) ?? []
        recent = try c.decodeIfPresent([Recent].self, forKey: .recent) ?? []
        today = try c.decodeIfPresent(Today.self, forKey: .today)
    }

    private enum CodingKeys: String, CodingKey {
        case updatedAt, idleSince, host, config, memory, running, queue, recent, today
    }

    public var busy: Bool { !running.isEmpty || !queue.isEmpty }
}
