import Darwin

// Thin Darwin wrappers; Foundation costs ~1.5 ms of dyld work per exec, so it stays out.

public func env(_ name: String) -> String? {
  guard let value = getenv(name) else { return nil }
  return String(cString: value)
}

/// `process.env[name]` is truthy.
public func envSet(_ name: String) -> Bool {
  guard let value = env(name) else { return false }
  return !value.isEmpty
}

public func readFile(_ path: String, limit: Int = 64 << 20) -> [UInt8]? {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var out: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 64 << 10)
  while out.count < limit {
    let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
    if n < 0 {
      if errno == EINTR { continue }
      return nil
    }
    if n == 0 { break }
    out.append(contentsOf: chunk[0..<n])
  }
  return out
}

public func writeAll(_ fd: Int32, _ bytes: [UInt8]) {
  bytes.withUnsafeBytes { buffer in
    var offset = 0
    while offset < buffer.count {
      let n = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
      if n < 0 {
        if errno == EINTR { continue }
        // Why: a closed reader (`| head`) must not turn a delivered result into a crash.
        return
      }
      offset += n
    }
  }
}

public func currentDirectory() -> String? {
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
  guard getcwd(&buffer, buffer.count) != nil else { return nil }
  return String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
}

public func monotonicMs() -> Int64 {
  var ts = timespec()
  clock_gettime(CLOCK_MONOTONIC, &ts)
  return Int64(ts.tv_sec) * 1000 + Int64(ts.tv_nsec) / 1_000_000
}

/// crypto.randomUUID(): RFC 4122 v4, lowercase.
public func randomUUID() -> String {
  var bytes = [UInt8](repeating: 0, count: 16)
  arc4random_buf(&bytes, 16)
  bytes[6] = (bytes[6] & 0x0F) | 0x40
  bytes[8] = (bytes[8] & 0x3F) | 0x80
  var out: [UInt8] = []
  out.reserveCapacity(36)
  for (i, b) in bytes.enumerated() {
    if i == 4 || i == 6 || i == 8 || i == 10 { out.append(0x2D) }
    out.append(hexDigit(b >> 4))
    out.append(hexDigit(b & 0xF))
  }
  return String(decoding: out, as: UTF8.self)
}

/// path.resolve for POSIX: absolute, `.`/`..` folded, no trailing slash.
public func resolvePosixPath(_ path: String, cwd: String) -> String {
  let joined = path.hasPrefix("/") ? path : cwd + "/" + path
  var parts: [Substring] = []
  for part in joined.split(separator: "/", omittingEmptySubsequences: true) {
    if part == "." { continue }
    if part == ".." {
      if !parts.isEmpty { parts.removeLast() }
      continue
    }
    parts.append(part)
  }
  return "/" + parts.joined(separator: "/")
}

public func isASCII(_ s: String) -> Bool { s.utf8.allSatisfy { $0 < 0x80 } }
