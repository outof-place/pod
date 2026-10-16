import Foundation

/// A public driver's snapshot when the version table has no translator path for this build
/// (pre-mortem triage 6). None ships yet; see `PublicInputFallback`.
protocol PublicAccessibilityFallback: Sendable {
    func snapshot(udid: String, options: AXSnapshotOptions) -> Result<AXSnapshotResult, HelperError>
}

struct NoPublicAccessibilityFallback: PublicAccessibilityFallback {
    func snapshot(udid: String, options: AXSnapshotOptions) -> Result<AXSnapshotResult, HelperError> {
        .failure(HelperError(.unsupported, "no public accessibility fallback in this helper (an XCTest driver is owed)"))
    }
}

struct AXParams: Decodable {
    let udid: String
    let maxNodes: Int?
    let filter: String?
    /// Off-screen and covered nodes too.
    let all: Bool?
    /// Hit-test each on-screen node so a covered one is not offered (default true).
    let hitTest: Bool?
}

extension HelperMethods {
    func ax(_ params: Data, fallback: PublicAccessibilityFallback = NoPublicAccessibilityFallback()) -> Reply {
        decode(AXParams.self, params) { params in
            guard UUID(uuidString: params.udid) != nil else { return .error(HelperError(.badParams, "udid is not a UUID")) }
            if let maxNodes = params.maxNodes, !(1...AXBudget.maxNodes).contains(maxNodes) {
                return .error(HelperError(.badParams, "maxNodes must be 1 to \(AXBudget.maxNodes)"))
            }
            if let filter = params.filter, filter.isEmpty || filter.count > 256 {
                return .error(HelperError(.badParams, "filter must be 1 to 256 characters"))
            }
            let options = AXSnapshotOptions(maxNodes: params.maxNodes ?? AXBudget.defaultMaxNodes, filter: params.filter, all: params.all ?? false)
            let taken: Result<AXSnapshotResult, HelperError>
            // Before any device lookup: with the table unknown CoreSimulator is not even loaded.
            if let refused = refusal(for: startupReport.capabilities.ax, .ax) {
                taken = fallback.snapshot(udid: params.udid.uppercased(), options: options)
                    .mapError { HelperError(refused.code, "\(refused.message); \($0.message)") }
            } else {
                switch booted(params.udid.uppercased()) {
                case .failure(let error): return .error(error)
                case .success(let device): taken = AccessibilitySnapshots.take(device, options: options, hitTest: params.hitTest ?? true)
                }
            }
            switch taken {
            case .failure(let error): return .error(error)
            case .success(let snapshot): return .encoding(snapshot)
            }
        }
    }
}
