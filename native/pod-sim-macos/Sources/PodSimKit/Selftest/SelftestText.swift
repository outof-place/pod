import Foundation

/// `pod-sim --selftest` without `--json`: one line per finding, for a person in a terminal.
public enum SelftestText {
    public static func render(_ report: SelftestReport) -> String {
        var lines: [String] = []
        if let xcode = report.xcode {
            lines.append("Xcode \(xcode.version ?? "?") (\(xcode.build ?? "?")) at \(xcode.developerDir), from \(xcode.source.rawValue)")
            if let reason = xcode.chosenBecause { lines.append("  chosen because \(reason)") }
        }
        if let core = report.coreSimulator { lines.append("CoreSimulator \(core.version) (\(core.build))") }
        if let kit = report.simulatorKit { lines.append("SimulatorKit \(kit.version) (\(kit.build)) at \(kit.path)") }
        if let macOS = report.macOS {
            let translator = report.accessibilityTranslation.map { ", AccessibilityPlatformTranslation \($0.version) (\($0.build))" } ?? ""
            lines.append("macOS \(macOS.version) (\(macOS.build))\(translator)")
        }
        if let problem = report.problem { lines.append("problem: \(problem)") }
        let table = report.table
        lines.append("version table (\(table.source.rawValue)): \(table.entry ?? (table.forcedUnknown ? "forced unknown" : "unknown build"))")
        if let error = table.overrideError { lines.append("override ignored: \(error)") }
        if let set = report.deviceSet { lines.append("device set \(set)") }
        if let device = report.device {
            lines.append("device \(device.name ?? "?") \(device.udid): \(device.state ?? "?")\(device.problem.map { " (\($0))" } ?? "")")
        }
        for capability in Capability.allCases {
            let entry = report.capabilities[capability]
            let detail = entry.reason ?? entry.note
            lines.append("\(capability.rawValue): \(entry.status.rawValue) [\(entry.checked.rawValue)]\(detail.map { " \($0)" } ?? "")")
        }
        if let fallback = report.fallbacks?.screenshot {
            lines.append("screenshot fallback (\(fallback.via)): \(fallback.status.rawValue)\(fallback.ms.map { " in \($0) ms" } ?? "")\(fallback.reason.map { ", \($0)" } ?? "")")
        }
        return lines.joined(separator: "\n")
    }
}
