/// One `com.apple.framebuffer.display` port as the helper sees it. Stage 0 found three on an iPhone
/// 16 Pro, one with a live 1206x2622 surface.
struct DisplayCandidate: Equatable, Sendable {
    let displayClass: UInt16?
    let width: Int?
    let height: Int?
}

enum MainDisplaySelection {
    /// Display class 0 is the main display (idb v1.7.2 `mainDisplaySurface`); without classes, the
    /// surface the size of the device's screen (serve-sim's rule, stage 0), then the largest surface.
    static func pick(_ candidates: [DisplayCandidate], devicePixels: (Int, Int)) -> Int? {
        if let main = candidates.firstIndex(where: { $0.displayClass == 0 }) { return main }
        let sized = candidates.indices.filter { candidates[$0].width != nil && candidates[$0].height != nil }
        if let exact = sized.first(where: { candidates[$0].width == devicePixels.0 && candidates[$0].height == devicePixels.1 }) {
            return exact
        }
        return sized.max { (candidates[$0].width! * candidates[$0].height!) < (candidates[$1].width! * candidates[$1].height!) }
    }
}
