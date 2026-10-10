// A JSON value that keeps the wire's own spelling of strings and numbers. The runtime writes
// frames with JSON.stringify, so re-emitting raw tokens is byte-identical to the Node CLI's
// JSON.parse + JSON.stringify round trip, with no JS number or escape formatting to reimplement.

public indirect enum JSONValue: Sendable {
  case null
  case bool(Bool)
  case number(String)
  case string(JSONString)
  case array([JSONValue])
  case object(JSONObject)
}

/// String content exactly as escaped on the wire, without the quotes.
public struct JSONString: Equatable, Sendable {
  public let raw: [UInt8]
  public let hasEscapes: Bool

  public init(raw: [UInt8], hasEscapes: Bool) {
    self.raw = raw
    self.hasEscapes = hasEscapes
  }

  /// A string built by this client, escaped the way JSON.stringify escapes it.
  public init(_ value: String) {
    var out: [UInt8] = []
    out.reserveCapacity(value.utf8.count)
    var escaped = false
    for unit in value.utf8 {
      switch unit {
      case 0x22: out += [0x5C, 0x22]; escaped = true
      case 0x5C: out += [0x5C, 0x5C]; escaped = true
      case 0x08: out += [0x5C, 0x62]; escaped = true
      case 0x0C: out += [0x5C, 0x66]; escaped = true
      case 0x0A: out += [0x5C, 0x6E]; escaped = true
      case 0x0D: out += [0x5C, 0x72]; escaped = true
      case 0x09: out += [0x5C, 0x74]; escaped = true
      case 0x00..<0x20:
        out += [0x5C, 0x75, 0x30, 0x30, hexDigit(unit >> 4), hexDigit(unit & 0xF)]
        escaped = true
      default: out.append(unit)
      }
    }
    raw = out
    hasEscapes = escaped
  }

  /// The decoded text as UTF-8; a lone surrogate becomes U+FFFD, as Node's UTF-8 encoder writes it.
  public var utf8: [UInt8] {
    if !hasEscapes {
      return raw
    }
    var out: [UInt8] = []
    out.reserveCapacity(raw.count)
    var i = 0
    while i < raw.count {
      let c = raw[i]
      if c != 0x5C {
        out.append(c)
        i += 1
        continue
      }
      let e = raw[i + 1]
      i += 2
      switch e {
      case 0x62: out.append(0x08)
      case 0x66: out.append(0x0C)
      case 0x6E: out.append(0x0A)
      case 0x72: out.append(0x0D)
      case 0x74: out.append(0x09)
      case 0x75:
        var code = UInt32(hex4(raw, i))
        i += 4
        if (0xD800..<0xDC00).contains(code), i + 5 < raw.count, raw[i] == 0x5C, raw[i + 1] == 0x75 {
          let low = UInt32(hex4(raw, i + 2))
          if (0xDC00..<0xE000).contains(low) {
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
            i += 6
          }
        }
        if (0xD800..<0xE000).contains(code) {
          code = 0xFFFD
        }
        appendUTF8(&out, code)
      default: out.append(e)
      }
    }
    return out
  }

  public var string: String {
    String(decoding: utf8, as: UTF8.self)
  }

  /// JS `.length` of the decoded string (UTF-16 code units).
  public var utf16Count: Int {
    var count = 0
    var i = 0
    while i < raw.count {
      let c = raw[i]
      if c == 0x5C {
        i += raw[i + 1] == 0x75 ? 6 : 2
        count += 1
      } else if c < 0x80 {
        i += 1
        count += 1
      } else if c < 0xE0 {
        i += 2
        count += 1
      } else if c < 0xF0 {
        i += 3
        count += 1
      } else {
        i += 4
        count += 2
      }
    }
    return count
  }

  public func equals(_ ascii: StaticString) -> Bool {
    guard !hasEscapes, raw.count == ascii.utf8CodeUnitCount else {
      return hasEscapes && string == ascii.description
    }
    return ascii.withUTF8Buffer { buffer in
      var i = 0
      while i < buffer.count {
        if buffer[i] != raw[i] { return false }
        i += 1
      }
      return true
    }
  }

  public func equals(_ other: String) -> Bool {
    if hasEscapes {
      return string == other
    }
    return raw.elementsEqual(other.utf8)
  }
}

public struct JSONObject: Sendable {
  public var entries: [(key: JSONString, value: JSONValue)]

  public init(_ entries: [(key: JSONString, value: JSONValue)] = []) {
    self.entries = entries
  }

  /// JSON.parse keeps the last duplicate; JSON.stringify never writes one.
  public subscript(key: StaticString) -> JSONValue? {
    var i = entries.count - 1
    while i >= 0 {
      if entries[i].key.equals(key) { return entries[i].value }
      i -= 1
    }
    return nil
  }

  public func value(forKey key: String) -> JSONValue? {
    var i = entries.count - 1
    while i >= 0 {
      if entries[i].key.equals(key) { return entries[i].value }
      i -= 1
    }
    return nil
  }

  public func has(_ key: StaticString) -> Bool { self[key] != nil }

  /// Spread semantics: an existing key keeps its position, a new one goes last.
  public mutating func set(_ key: String, _ value: JSONValue) {
    for i in entries.indices where entries[i].key.equals(key) {
      entries[i].value = value
      return
    }
    entries.append((JSONString(key), value))
  }
}

public extension JSONValue {
  static func str(_ value: String) -> JSONValue { .string(JSONString(value)) }

  static func int(_ value: Int) -> JSONValue { .number(String(value)) }

  subscript(key: StaticString) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }

  var objectValue: JSONObject? {
    if case .object(let object) = self { return object }
    return nil
  }

  var arrayValue: [JSONValue]? {
    if case .array(let array) = self { return array }
    return nil
  }

  var stringValue: JSONString? {
    if case .string(let string) = self { return string }
    return nil
  }

  var isNull: Bool {
    if case .null = self { return true }
    return false
  }

  var isObject: Bool { objectValue != nil }
}

// MARK: - Parsing (JSON.parse grammar)

public struct JSONParseError: Error {}

public func parseJSON(_ bytes: [UInt8]) throws(JSONParseError) -> JSONValue {
  try bytes.withUnsafeBufferPointer { (buffer) throws(JSONParseError) -> JSONValue in
    var parser = JSONParser(buffer: buffer)
    parser.skipWhitespace()
    let value = try parser.parseValue(depth: 0)
    parser.skipWhitespace()
    guard parser.index == buffer.count else { throw JSONParseError() }
    return value
  }
}

private struct JSONParser {
  let buffer: UnsafeBufferPointer<UInt8>
  var index = 0

  init(buffer: UnsafeBufferPointer<UInt8>) {
    self.buffer = buffer
  }

  mutating func skipWhitespace() {
    while index < buffer.count {
      switch buffer[index] {
      case 0x20, 0x09, 0x0A, 0x0D: index += 1
      default: return
      }
    }
  }

  mutating func parseValue(depth: Int) throws(JSONParseError) -> JSONValue {
    guard index < buffer.count, depth < 10_000 else { throw JSONParseError() }
    switch buffer[index] {
    case 0x7B: return try parseObject(depth: depth)
    case 0x5B: return try parseArray(depth: depth)
    case 0x22: return .string(try parseString())
    case 0x74: try literal("true"); return .bool(true)
    case 0x66: try literal("false"); return .bool(false)
    case 0x6E: try literal("null"); return .null
    default: return try parseNumber()
    }
  }

  mutating func literal(_ word: StaticString) throws(JSONParseError) {
    let n = word.utf8CodeUnitCount
    guard index + n <= buffer.count else { throw JSONParseError() }
    let ok = word.withUTF8Buffer { w in
      var i = 0
      while i < n {
        if buffer[index + i] != w[i] { return false }
        i += 1
      }
      return true
    }
    guard ok else { throw JSONParseError() }
    index += n
  }

  mutating func parseObject(depth: Int) throws(JSONParseError) -> JSONValue {
    index += 1
    var entries: [(key: JSONString, value: JSONValue)] = []
    skipWhitespace()
    if index < buffer.count, buffer[index] == 0x7D {
      index += 1
      return .object(JSONObject(entries))
    }
    while true {
      skipWhitespace()
      guard index < buffer.count, buffer[index] == 0x22 else { throw JSONParseError() }
      let key = try parseString()
      skipWhitespace()
      guard index < buffer.count, buffer[index] == 0x3A else { throw JSONParseError() }
      index += 1
      skipWhitespace()
      let value = try parseValue(depth: depth + 1)
      if let existing = entries.firstIndex(where: { $0.key == key }) {
        entries[existing].value = value
      } else {
        entries.append((key, value))
      }
      skipWhitespace()
      guard index < buffer.count else { throw JSONParseError() }
      if buffer[index] == 0x2C {
        index += 1
        continue
      }
      guard buffer[index] == 0x7D else { throw JSONParseError() }
      index += 1
      return .object(JSONObject(entries))
    }
  }

  mutating func parseArray(depth: Int) throws(JSONParseError) -> JSONValue {
    index += 1
    var items: [JSONValue] = []
    skipWhitespace()
    if index < buffer.count, buffer[index] == 0x5D {
      index += 1
      return .array(items)
    }
    while true {
      skipWhitespace()
      items.append(try parseValue(depth: depth + 1))
      skipWhitespace()
      guard index < buffer.count else { throw JSONParseError() }
      if buffer[index] == 0x2C {
        index += 1
        continue
      }
      guard buffer[index] == 0x5D else { throw JSONParseError() }
      index += 1
      return .array(items)
    }
  }

  mutating func parseString() throws(JSONParseError) -> JSONString {
    index += 1
    let start = index
    var escapes = false
    while index < buffer.count {
      let c = buffer[index]
      if c == 0x22 {
        let raw = Array(buffer[start..<index])
        index += 1
        return JSONString(raw: raw, hasEscapes: escapes)
      }
      if c < 0x20 { throw JSONParseError() }
      if c == 0x5C {
        escapes = true
        guard index + 1 < buffer.count else { throw JSONParseError() }
        switch buffer[index + 1] {
        case 0x22, 0x5C, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74: index += 2
        case 0x75:
          guard index + 5 < buffer.count else { throw JSONParseError() }
          for k in 2...5 where hexValue(buffer[index + k]) == nil { throw JSONParseError() }
          index += 6
        default: throw JSONParseError()
        }
        continue
      }
      index += 1
    }
    throw JSONParseError()
  }

  mutating func parseNumber() throws(JSONParseError) -> JSONValue {
    let start = index
    if index < buffer.count, buffer[index] == 0x2D { index += 1 }
    guard index < buffer.count else { throw JSONParseError() }
    if buffer[index] == 0x30 {
      index += 1
    } else if isDigit(buffer[index]) {
      while index < buffer.count, isDigit(buffer[index]) { index += 1 }
    } else {
      throw JSONParseError()
    }
    if index < buffer.count, buffer[index] == 0x2E {
      index += 1
      guard index < buffer.count, isDigit(buffer[index]) else { throw JSONParseError() }
      while index < buffer.count, isDigit(buffer[index]) { index += 1 }
    }
    if index < buffer.count, buffer[index] == 0x65 || buffer[index] == 0x45 {
      index += 1
      if index < buffer.count, buffer[index] == 0x2B || buffer[index] == 0x2D { index += 1 }
      guard index < buffer.count, isDigit(buffer[index]) else { throw JSONParseError() }
      while index < buffer.count, isDigit(buffer[index]) { index += 1 }
    }
    return .number(String(decoding: buffer[start..<index], as: UTF8.self))
  }
}

// MARK: - Writing (JSON.stringify)

public extension JSONValue {
  /// JSON.stringify(value, null, 2), or compact when `indent` is nil.
  func stringify(indent: Int? = 2) -> [UInt8] {
    var out: [UInt8] = []
    write(into: &out, indent: indent, depth: 0)
    return out
  }

  func write(into out: inout [UInt8], indent: Int?, depth: Int) {
    switch self {
    case .null: out += Array("null".utf8)
    case .bool(let value): out += Array((value ? "true" : "false").utf8)
    case .number(let raw): out += Array(raw.utf8)
    case .string(let string):
      out.append(0x22)
      out += string.raw
      out.append(0x22)
    case .array(let items):
      if items.isEmpty {
        out += [0x5B, 0x5D]
        return
      }
      out.append(0x5B)
      for (i, item) in items.enumerated() {
        if i > 0 { out.append(0x2C) }
        newline(&out, indent: indent, depth: depth + 1)
        item.write(into: &out, indent: indent, depth: depth + 1)
      }
      newline(&out, indent: indent, depth: depth)
      out.append(0x5D)
    case .object(let object):
      if object.entries.isEmpty {
        out += [0x7B, 0x7D]
        return
      }
      out.append(0x7B)
      for (i, entry) in object.entries.enumerated() {
        if i > 0 { out.append(0x2C) }
        newline(&out, indent: indent, depth: depth + 1)
        out.append(0x22)
        out += entry.key.raw
        out.append(0x22)
        out.append(0x3A)
        if indent != nil { out.append(0x20) }
        entry.value.write(into: &out, indent: indent, depth: depth + 1)
      }
      newline(&out, indent: indent, depth: depth)
      out.append(0x7D)
    }
  }
}

private func newline(_ out: inout [UInt8], indent: Int?, depth: Int) {
  guard let indent else { return }
  out.append(0x0A)
  out += [UInt8](repeating: 0x20, count: indent * depth)
}

// MARK: - Byte helpers

@inline(__always) func isDigit(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

@inline(__always) func hexDigit(_ v: UInt8) -> UInt8 { v < 10 ? 0x30 + v : 0x61 + v - 10 }

@inline(__always) func hexValue(_ c: UInt8) -> UInt16? {
  switch c {
  case 0x30...0x39: return UInt16(c - 0x30)
  case 0x41...0x46: return UInt16(c - 0x41 + 10)
  case 0x61...0x66: return UInt16(c - 0x61 + 10)
  default: return nil
  }
}

func hex4(_ raw: [UInt8], _ at: Int) -> UInt16 {
  var v: UInt16 = 0
  for k in 0..<4 { v = v << 4 | (hexValue(raw[at + k]) ?? 0) }
  return v
}

func appendUTF8(_ out: inout [UInt8], _ code: UInt32) {
  switch code {
  case 0..<0x80: out.append(UInt8(code))
  case 0x80..<0x800:
    out.append(UInt8(0xC0 | (code >> 6)))
    out.append(UInt8(0x80 | (code & 0x3F)))
  case 0x800..<0x10000:
    out.append(UInt8(0xE0 | (code >> 12)))
    out.append(UInt8(0x80 | ((code >> 6) & 0x3F)))
    out.append(UInt8(0x80 | (code & 0x3F)))
  default:
    out.append(UInt8(0xF0 | (code >> 18)))
    out.append(UInt8(0x80 | ((code >> 12) & 0x3F)))
    out.append(UInt8(0x80 | ((code >> 6) & 0x3F)))
    out.append(UInt8(0x80 | (code & 0x3F)))
  }
}
