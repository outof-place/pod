// JS value semantics the Node CLI's formatters rely on: template-literal ToString,
// truthiness and nullish checks, applied to a parsed field that may be absent (undefined).

public extension Optional where Wrapped == JSONValue {
  /// `value.key`, with a missing parent reading as undefined.
  subscript(key: StaticString) -> JSONValue? {
    if case .some(.object(let object)) = self { return object[key] }
    return nil
  }

  var arrayValue: [JSONValue]? {
    if case .some(.array(let items)) = self { return items }
    return nil
  }

  /// `${value}` in a template literal.
  var templateString: String {
    switch self {
    case .none: return "undefined"
    case .some(let value): return value.templateString
    }
  }

  /// JS truthiness.
  var truthy: Bool {
    switch self {
    case .none: return false
    case .some(let value): return value.truthy
    }
  }

  /// `value ?? fallback` where `fallback` is already a string.
  func nullish(_ fallback: String) -> String {
    switch self {
    case .none, .some(.null): return fallback
    case .some(let value): return value.templateString
    }
  }

  var isNullish: Bool {
    switch self {
    case .none, .some(.null): return true
    default: return false
    }
  }

  /// `typeof value === 'string'`
  var isString: Bool {
    if case .some(.string) = self { return true }
    return false
  }

  var isNull: Bool {
    if case .some(.null) = self { return true }
    return false
  }

  func isString(_ ascii: StaticString) -> Bool {
    if case .some(.string(let s)) = self { return s.equals(ascii) }
    return false
  }
}

/// Array.prototype.join: null and undefined members print as empty strings.
public func jsJoin(_ items: [JSONValue], _ separator: String) -> String {
  items.map { item -> String in
    if case .null = item { return "" }
    return item.templateString
  }.joined(separator: separator)
}

public extension JSONValue {
  var templateString: String {
    switch self {
    case .null: return "null"
    case .bool(let value): return value ? "true" : "false"
    case .number(let raw): return raw
    case .string(let string): return string.string
    case .array(let items):
      return items.map { item -> String in
        switch item {
        case .null: return ""
        default: return item.templateString
        }
      }.joined(separator: ",")
    case .object: return "[object Object]"
    }
  }

  var truthy: Bool {
    switch self {
    case .null: return false
    case .bool(let value): return value
    case .number(let raw): return !(raw == "0" || raw == "-0")
    case .string(let string): return !string.raw.isEmpty
    case .array, .object: return true
    }
  }
}
