import Foundation

public enum FramerEvent: Equatable, Sendable {
    case frame(Data)
    /// A line longer than the limit; its bytes were dropped as they came, never buffered.
    case oversized(byteCount: Int)
}

/// Newline-delimited frames with a size cap, so a peer can never make the helper buffer without bound.
/// The limit counts the bytes before the newline. Blank lines are skipped and a trailing CR dropped.
public struct LineFramer: Sendable {
    public let maxFrameBytes: Int
    private var buffer: [UInt8] = []
    /// Bytes of the current line dropped so far; nil while the line is still under the limit.
    private var discarded: Int?

    public init(maxFrameBytes: Int) {
        self.maxFrameBytes = maxFrameBytes
    }

    public var bufferedByteCount: Int { buffer.count }

    public mutating func push(_ bytes: some Collection<UInt8>) -> [FramerEvent] {
        var events: [FramerEvent] = []
        var rest = bytes[...]
        while !rest.isEmpty {
            guard let newline = rest.firstIndex(of: 0x0A) else {
                append(rest)
                break
            }
            append(rest[..<newline])
            if let event = endLine() { events.append(event) }
            rest = rest[rest.index(after: newline)...]
        }
        return events
    }

    /// End of input: a last line without a newline still counts.
    public mutating func finish() -> [FramerEvent] {
        guard !buffer.isEmpty || discarded != nil else { return [] }
        return endLine().map { [$0] } ?? []
    }

    private mutating func append(_ chunk: some Collection<UInt8>) {
        if let count = discarded {
            discarded = count + chunk.count
        } else if buffer.count + chunk.count > maxFrameBytes {
            discarded = buffer.count + chunk.count
            buffer.removeAll(keepingCapacity: false)
        } else {
            buffer.append(contentsOf: chunk)
        }
    }

    private mutating func endLine() -> FramerEvent? {
        defer {
            buffer.removeAll(keepingCapacity: true)
            discarded = nil
        }
        if let count = discarded { return .oversized(byteCount: count) }
        var line = buffer[...]
        if line.last == 0x0D { line = line.dropLast() }
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { return nil }
        return .frame(Data(line))
    }
}
