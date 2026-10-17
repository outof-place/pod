import Foundation

/// The framebuffer cut into square tiles; settle compares tile hashes between frames.
struct TileGrid: Equatable, Sendable {
    /// 16 px is 5.3 points at @3x: a 36-point spinner spans at most 8 tiles, 43 points.
    static let defaultTile = 16

    let width: Int
    let height: Int
    let tile: Int

    init(width: Int, height: Int, tile: Int = TileGrid.defaultTile) {
        self.width = max(1, width)
        self.height = max(1, height)
        self.tile = max(1, tile)
    }

    var tilesX: Int { (width + tile - 1) / tile }
    var tilesY: Int { (height + tile - 1) / tile }
    var count: Int { tilesX * tilesY }
}

/// One bit per tile.
struct TileBits: Equatable, Sendable {
    private(set) var words: [UInt64]

    init(count: Int) {
        words = [UInt64](repeating: 0, count: (count + 63) / 64)
    }

    var isEmpty: Bool { words.allSatisfy { $0 == 0 } }

    func contains(_ index: Int) -> Bool { words[index >> 6] & (1 << UInt64(index & 63)) != 0 }

    mutating func insert(_ index: Int) { words[index >> 6] |= 1 << UInt64(index & 63) }

    mutating func formUnion(_ other: TileBits) {
        for i in words.indices { words[i] |= other.words[i] }
    }

    mutating func removeAll() {
        for i in words.indices { words[i] = 0 }
    }
}

struct PixelRect: Equatable, Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

/// Points in the device's native (portrait) orientation, origin top left: `ax` and `hid` space on a
/// portrait app.
public struct PointRect: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    /// Whole points that cover the pixels.
    init(_ pixels: PixelRect, scale: Double) {
        let left = (Double(pixels.x) / scale).rounded(.down), top = (Double(pixels.y) / scale).rounded(.down)
        x = left
        y = top
        width = (Double(pixels.x + pixels.width) / scale).rounded(.up) - left
        height = (Double(pixels.y + pixels.height) / scale).rounded(.up) - top
    }
}

/// What moved: regions that keep a screen from settling, and the small ones settle allows (a caret,
/// a spinner). Pixels.
struct MotionSplit: Equatable, Sendable {
    let blocking: [PixelRect]
    let ignored: [PixelRect]

    static let none = MotionSplit(blocking: [], ignored: [])
}

/// Pure: which tiles changed, their connected regions, and which of those are small enough to ignore.
enum DamageMap {
    /// Sets the bit of every tile whose hash differs.
    static func changed(previous: [UInt64], current: [UInt64], into bits: inout TileBits) {
        for i in 0..<min(previous.count, current.count) where previous[i] != current[i] { bits.insert(i) }
    }

    /// Bounding boxes of the 8-connected groups of set tiles, in pixels clipped to the surface,
    /// largest area first.
    static func regions(_ bits: TileBits, grid: TileGrid) -> [PixelRect] {
        guard !bits.isEmpty else { return [] }
        var seen = TileBits(count: grid.count)
        var stack: [Int] = []
        var found: [PixelRect] = []
        for start in 0..<grid.count where bits.contains(start) && !seen.contains(start) {
            var (minX, minY, maxX, maxY) = (Int.max, Int.max, Int.min, Int.min)
            seen.insert(start)
            stack.append(start)
            while let index = stack.popLast() {
                let tx = index % grid.tilesX, ty = index / grid.tilesX
                minX = min(minX, tx)
                maxX = max(maxX, tx)
                minY = min(minY, ty)
                maxY = max(maxY, ty)
                for dy in -1...1 {
                    for dx in -1...1 where dx != 0 || dy != 0 {
                        let nx = tx + dx, ny = ty + dy
                        guard nx >= 0, ny >= 0, nx < grid.tilesX, ny < grid.tilesY else { continue }
                        let neighbour = ny * grid.tilesX + nx
                        if bits.contains(neighbour), !seen.contains(neighbour) {
                            seen.insert(neighbour)
                            stack.append(neighbour)
                        }
                    }
                }
            }
            let x = minX * grid.tile, y = minY * grid.tile
            found.append(PixelRect(
                x: x, y: y, width: min(grid.width, (maxX + 1) * grid.tile) - x, height: min(grid.height, (maxY + 1) * grid.tile) - y))
        }
        return found.sorted { $0.width * $0.height > $1.width * $1.height }
    }

    /// A region at most `smallPt` points on each side is a caret or a spinner; more than `maxSmall`
    /// of them is a moving screen (a list of shimmering cells), and then all of them block.
    static func split(_ regions: [PixelRect], scale: Double, smallPt: Double, maxSmall: Int) -> MotionSplit {
        let isSmall = { (r: PixelRect) in Double(r.width) / scale <= smallPt && Double(r.height) / scale <= smallPt }
        let small = regions.filter(isSmall)
        guard small.count <= maxSmall else { return MotionSplit(blocking: regions, ignored: []) }
        return MotionSplit(blocking: regions.filter { !isSmall($0) }, ignored: small)
    }
}
