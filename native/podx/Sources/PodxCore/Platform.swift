import Darwin

// Thin Darwin wrappers; Foundation costs ~1.5 ms of dyld work per exec, so it stays out.

// Fork-only (Pod): an unset name is read in the other spelling too. The decouple renames this
// front's names to POD_, but a terminal opened before that update keeps only the ORCA_ ones: so
// the POD_ spelling, else the ORCA_ one (and before the decouple, the reverse). The ORCA_ one
// counts only in a Pod terminal: an Orca.app terminal's names Orca's runtime and token.
// TODO(pod): drop the fallback after 2026-12-31, and no earlier than the release after the decouple.
public let envSpellings = (current: "POD_", legacy: "ORCA_")  // pod-decouple:keep

public func env(_ name: String) -> String? {
  if let value = getenv(name) { return String(cString: value) }
  let (current, legacy) = envSpellings
  let other: String
  if name.hasPrefix(current) {
    guard legacyEnvIsPods() else { return nil }
    other = legacy + String(name.dropFirst(current.count))
  } else if name.hasPrefix(legacy) {
    other = current + String(name.dropFirst(legacy.count))
  } else {
    return nil
  }
  guard let value = getenv(other) else { return nil }
  return String(cString: value)
}

/// `path` with every symlink resolved; nil when it doesn't exist.
public func resolvedPath(_ path: String) -> String? {
  guard let resolved = realpath(path, nil) else { return nil }
  defer { free(resolved) }
  return String(cString: resolved)
}

/// Whether `path` lies in Pod's own data folder under `home`, both resolved.
public func isInPodUserData(_ path: String, home: String) -> Bool {
  guard let path = resolvedPath(path),
    let root = resolvedPath(home + "/Library/Application Support/" + PRODUCT_USER_DATA_NAME)
  else { return false }
  return path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
}

/// A terminal's ORCA_ env is a Pod's when its user data lies in Pod's data folder.
public func legacyEnvIsPods() -> Bool {
  guard let home = getenv("HOME"), let named = getenv(envSpellings.legacy + "USER_DATA_PATH")
  else { return false }
  return isInPodUserData(String(cString: named), home: String(cString: home))
}

/// After the decouple, the ORCA_ user data of a terminal that isn't a Pod's (Orca.app's), when
/// nothing names Pod's: podx refuses it rather than talk to that app's runtime.
public func refusedLegacyUserData() -> String? {
  guard USER_DATA_ENV.hasPrefix(envSpellings.current), getenv(USER_DATA_ENV) == nil,
    let named = getenv(envSpellings.legacy + "USER_DATA_PATH"), !legacyEnvIsPods()
  else { return nil }
  return String(cString: named)
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
