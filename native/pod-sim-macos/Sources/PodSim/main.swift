import Foundation
import PodSimKit

let usage = """
usage: pod-sim                                  serve protocol v1 on stdio (Pod's runtime starts it, with POD_SIM_TOKEN)
       pod-sim --selftest [--json] [--udid <udid>] [--wait-ms <n>]
       pod-sim --version

Environment: DEVELOPER_DIR (else xcode-select -p) picks Xcode; POD_SIM_VERSION_TABLE=<file> overlays the
version table; POD_SIM_FORCE_UNKNOWN_BUILD=1 treats this build as unknown (drills, tests);
POD_SIM_DEVICE_SET=<dir> uses that device set instead of the default (probes).

"""

setvbuf(stdout, nil, _IOLBF, 0)
let arguments = Array(CommandLine.arguments.dropFirst())
let environment = ProcessInfo.processInfo.environment

func value(after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("pod-sim: \(message)\n\n\(usage)".utf8))
    exit(64)
}

if arguments.isEmpty {
    HelperServer.run(environment: environment)
}
if arguments == ["--version"] {
    print("pod-sim \(HelperVersion.current) protocol \(HelperProtocol.version)")
    exit(0)
}
guard arguments.first == "--selftest" else { fail("unknown arguments \(arguments.joined(separator: " "))") }

let udid = value(after: "--udid")
if let udid, UUID(uuidString: udid) == nil { fail("--udid \(udid) is not a UUID") }
let waitMs = value(after: "--wait-ms").map { Int($0) ?? -1 } ?? 1500
if waitMs < 0 { fail("--wait-ms needs a number") }

let context = HelperContext.discover(environment: environment)
let report = SelftestRunner.run(SelftestOptions(udid: udid, waitMs: waitMs, environment: environment), context: context)
if arguments.contains("--json") {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    print(String(decoding: (try? encoder.encode(report)) ?? Data("{}".utf8), as: UTF8.self))
} else {
    print(SelftestText.render(report))
}
// A finished report is the answer, whatever it says; exit codes are for usage errors.
exit(0)
