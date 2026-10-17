// `pod-agent-launcher --disclaim-exec <program> [args...]`: execs <program> in place (same pid),
// responsible for itself. Why: src/main/daemon/daemon-responsibility-darwin.ts.

import Darwin

// libquarantine SPI without a header. Chromium (base/process/launch_mac.cc) and Electron's
// utilityProcess `disclaim` pass it the attributes' address.
private typealias SetDisclaim =
  @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
private let disclaimSymbol = "responsibility_spawnattrs_setdisclaim"
// <dlfcn.h> RTLD_DEFAULT, a macro Swift does not import.
private let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)

/// Without the symbol, or when the disclaiming exec fails, prints one line (Pod logs it) and execs
/// the program as before, attributed to this process's parent.
func disclaimExec(_ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Never {
  guard let program = argv[0] else {
    fail("usage: \(launcherName) --disclaim-exec <program> [args...]", code: 64)
  }
  let path = String(cString: program)
  var reason = "\(disclaimSymbol) is unavailable"
  if let symbol = dlsym(rtldDefault, disclaimSymbol) {
    let error = execDisclaimed(program, argv, unsafeBitCast(symbol, to: SetDisclaim.self))
    reason = "\(disclaimSymbol): \(String(cString: strerror(error)))"
  }
  fputs("\(launcherName): \(path) starts without its own responsibility (\(reason))\n", stderr)
  execv(program, argv)
  fail("\(path): \(String(cString: strerror(errno)))", code: 126)
}

/// Returns only on failure, with the error.
private func execDisclaimed(
  _ program: UnsafeMutablePointer<CChar>,
  _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
  _ setDisclaim: SetDisclaim
) -> Int32 {
  var attributes: posix_spawnattr_t?
  var result = posix_spawnattr_init(&attributes)
  guard result == 0 else { return result }
  defer { posix_spawnattr_destroy(&attributes) }
  result = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETEXEC))
  if result == 0 { result = setDisclaim(&attributes, 1) }
  if result == 0 {
    var pid: pid_t = 0
    result = posix_spawn(&pid, program, nil, &attributes, argv, environ)
  }
  return result
}
