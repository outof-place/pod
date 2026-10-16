import Foundation

/// A short-lived public tool (`xcode-select`, `xcrun simctl`) with a deadline.
enum Subprocess {
    /// How long a child that passed its timeout gets to end after SIGTERM.
    static let terminateGrace: TimeInterval = 2

    struct Failure: Error, Sendable {
        let text: String
    }

    struct Output: Sendable {
        let status: Int32
        let stdout: Data
        let stderr: Data
    }

    /// Fails with a short description when the tool does not start, times out or exits non-zero.
    /// `input` goes to the tool's stdin, which is closed after it (`simctl pbcopy` reads to the end).
    static func run(
        _ executable: String, _ arguments: [String], environment: [String: String]?, timeout: TimeInterval, input: Data? = nil
    ) -> Result<Output, Failure> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        let stdin = input.map { _ in Pipe() }
        process.standardInput = stdin ?? FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        do {
            try process.run()
        } catch {
            return .failure(Failure(text: "did not start: \(error.localizedDescription)"))
        }
        if let stdin, let input {
            DispatchQueue.global(qos: .userInitiated).async {
                try? stdin.fileHandleForWriting.write(contentsOf: input)
                try? stdin.fileHandleForWriting.close()
            }
        }
        // Drained while it runs, so a chatty tool never blocks on a full pipe.
        let stdout = Collected(), stderr = Collected()
        let readers = DispatchGroup()
        for (pipe, sink) in [(out, stdout), (err, stderr)] {
            readers.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                sink.data = pipe.fileHandleForReading.readDataToEndOfFile()
                readers.leave()
            }
        }
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            _ = exited.wait(timeout: .now() + terminateGrace)
            return .failure(Failure(text: "timed out after \(Int(timeout)) s"))
        }
        _ = readers.wait(timeout: .now() + 2)
        let output = Output(status: process.terminationStatus, stdout: stdout.data, stderr: stderr.data)
        guard output.status == 0 else {
            let tail = String(decoding: output.stderr.suffix(400), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(Failure(text: "exited \(output.status)\(tail.isEmpty ? "" : ": \(tail)")"))
        }
        return .success(output)
    }

    private final class Collected: @unchecked Sendable {
        var data = Data()
    }
}
