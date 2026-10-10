import Foundation

/// claude-acc writes its JSON in snake_case.
public enum AccJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        try? decoder().decode(type, from: data)
    }
}

/// Hands out a file's bytes only when it changed since the last call. Observation tells every
/// view about every assignment, equal or not, so an unchanged file is neither read nor assigned.
struct AccFileTracker {
    private struct Stamp: Equatable {
        let modified: Date
        let size: Int
    }

    private var seen: [URL: Stamp?] = [:]

    /// The new contents; nil when unchanged. A file that disappeared reads as empty `Data`.
    mutating func changed(_ url: URL) -> Data? {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let stamp = values.flatMap { values in
            values.contentModificationDate.map { Stamp(modified: $0, size: values.fileSize ?? 0) }
        }
        if let previous = seen[url], previous == stamp {
            return nil
        }
        seen[url] = stamp
        guard stamp != nil else { return Data() }
        return (try? Data(contentsOf: url)) ?? Data()
    }
}
