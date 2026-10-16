import Foundation

/// Serves protocol v1 on stdio until stdin closes (the runtime went away), then detaches every
/// display and exits 0. Stray writes to stdout from any framework land on stderr: the protocol
/// keeps its own copy of the original stdout.
public enum HelperServer {
    public static func run(environment: [String: String]) -> Never {
        guard let token = environment[HelperProtocol.tokenEnvironmentKey], token.count >= 16 else {
            FileHandle.standardError.write(Data("pod-sim: \(HelperProtocol.tokenEnvironmentKey) is not set; Pod's runtime starts this helper. Try pod-sim --selftest.\n".utf8))
            exit(64)
        }
        signal(SIGPIPE, SIG_IGN)
        let protocolOut = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        let writer = FrameWriter(fd: protocolOut)

        let methods = HelperMethods(environment: environment)
        let session = ProtocolSession(token: token, handler: methods, send: writer.write)
        let reader = Thread {
            var framer = LineFramer(maxFrameBytes: HelperProtocol.maxFrameBytes)
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(STDIN_FILENO, &buffer, buffer.count)
                if count < 0, errno == EINTR { continue }
                if count <= 0 { break }
                for event in framer.push(buffer[0..<count]) { session.receive(event) }
            }
            for event in framer.finish() { session.receive(event) }
            methods.detachAll()
            exit(0)
        }
        reader.name = "pod-sim.stdin"
        reader.start()
        // The main queue stays free for frameworks that call back on it.
        dispatchMain()
    }
}

/// One diagnostic line on stderr, which the runtime logs.
enum HelperLog {
    static func note(_ message: String) {
        FileHandle.standardError.write(Data("pod-sim: \(message)\n".utf8))
    }
}

/// Whole frames, one writer at a time; a gone reader ends the helper.
final class FrameWriter: @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()

    init(fd: Int32) {
        self.fd = fd
    }

    func write(_ frame: Data) {
        lock.withLock {
            frame.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let written = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if written < 0, errno == EINTR { continue }
                    if written <= 0 { exit(0) }
                    offset += written
                }
            }
        }
    }
}
