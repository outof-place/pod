/// USB HID keyboard usages (page 7) on a US layout: what DTUHID's `IndigoKeyboardButtonEvent` carries.
/// Every printable ASCII character, newline and tab has one; nothing else does (stage 0: "ą" and
/// "ż" have no US usage, so non-ASCII text goes through the pasteboard).
enum KeyboardUsage {
    static let leftControl: UInt16 = 0xE0
    static let leftShift: UInt16 = 0xE1
    static let leftOption: UInt16 = 0xE2
    static let leftCommand: UInt16 = 0xE3
    static let v: UInt16 = 0x19

    /// The frozen contract's key names (src/shared/rpc-contract/sim-params.ts SIM_KEYS).
    static let named: [String: UInt16] = [
        "return": 0x28, "escape": 0x29, "delete": 0x2A, "tab": 0x2B, "space": 0x2C,
        "forwardDelete": 0x4C, "home": 0x4A, "pageUp": 0x4B, "end": 0x4D, "pageDown": 0x4E,
        "arrowRight": 0x4F, "arrowLeft": 0x50, "arrowDown": 0x51, "arrowUp": 0x52,
    ]

    static let modifiers: [String: UInt16] = [
        "control": leftControl, "shift": leftShift, "option": leftOption, "command": leftCommand,
    ]

    private static let unshifted: [Character: UInt16] = [
        " ": 0x2C, "\n": 0x28, "\t": 0x2B, "-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30, "\\": 0x31,
        ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38,
    ]

    private static let shifted: [Character: UInt16] = [
        "!": 0x1E, "@": 0x1F, "#": 0x20, "$": 0x21, "%": 0x22, "^": 0x23, "&": 0x24, "*": 0x25, "(": 0x26, ")": 0x27,
        "_": 0x2D, "+": 0x2E, "{": 0x2F, "}": 0x30, "|": 0x31, ":": 0x33, "\"": 0x34, "~": 0x35, "<": 0x36, ">": 0x37, "?": 0x38,
    ]

    /// The usage and whether shift is held for it, or nil when a US keyboard has no key for it.
    static func usage(for character: Character) -> (usage: UInt16, shift: Bool)? {
        if character == "\r\n" { return (0x28, false) }
        guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first else { return nil }
        switch scalar.value {
        case 0x61...0x7A: return (UInt16(0x04 + scalar.value - 0x61), false)
        case 0x41...0x5A: return (UInt16(0x04 + scalar.value - 0x41), true)
        case 0x31...0x39: return (UInt16(0x1E + scalar.value - 0x31), false)
        case 0x30: return (0x27, false)
        default: break
        }
        if let usage = unshifted[character] { return (usage, false) }
        if let usage = shifted[character] { return (usage, true) }
        return nil
    }

    static func typable(_ text: String) -> Bool {
        text.allSatisfy { usage(for: $0) != nil }
    }
}
