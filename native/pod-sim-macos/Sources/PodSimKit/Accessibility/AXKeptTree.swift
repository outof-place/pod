import Foundation

/// Why a parallel read failed, and what that says about the route.
struct AXParallelFailure: Error {
    enum Kind: String, Sendable {
        /// The translator or its attribute numbers are not there.
        case unavailable
        /// The device's service could not be looked up.
        case lookup
        /// The device answered nothing on our connections: the endpoint may be stale.
        case unanswered
        /// The answers could not all be converted without asking the device.
        case conversion
        /// The read passed its budget: the device was slow, the route may be fine.
        case budget
    }

    let kind: Kind
    let error: HelperError
}

/// `ax`'s one decision about the kept tree: answer from it, or read and keep what was read.
enum AXKeptTree {
    struct Answer {
        var tree: AXTreeRead
        var hits: [Int: Bool?]
        let basis: AXBasis
        /// The stamp the tree was read or served under: hit answers join the kept tree under it.
        let stamp: AXScreenStamp?
    }

    /// The kept tree while the stamp taken now matches it and `fresh` is not asked; otherwise `read`,
    /// kept under that same stamp. Taken before anything is read, so a notification, an input or a
    /// redraw during the read leaves the kept tree a stamp the next call no longer matches. A read the
    /// device answered nothing to calls `discard` (the session's endpoint may be stale).
    static func answer(
        keeper: AXTreeKeeper, fresh: Bool, surface: () -> (id: UInt32, seed: UInt32)?,
        read: () -> Result<AXTreeRead, AXParallelFailure>, discard: () -> Void
    ) -> Result<Answer, AXParallelFailure> {
        let stamp = keeper.stamp(surface: surface())
        if !fresh, let kept = keeper.cached(at: stamp) {
            return .success(Answer(tree: kept.tree, hits: kept.hits, basis: .cache, stamp: stamp))
        }
        switch read() {
        case .failure(let failure):
            if failure.kind == .unanswered { discard() }
            return .failure(failure)
        case .success(let tree):
            keeper.keep(tree, stamp: stamp)
            return .success(Answer(tree: tree, hits: [:], basis: .parallel, stamp: stamp))
        }
    }
}
