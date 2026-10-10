import Darwin
import MachO
import PodxCore

// The Node CLI stays the source of truth: anything the native client does not fully understand
// is exec'd there before a request is sent. Packaged, that is the bash launcher kept next to this
// binary as podx-node; POD_NATIVE_CLI_NODE + POD_NATIVE_CLI_NODE_ENTRY point a dev build at a
// Node and an out/cli/index.js instead.

func execNodeCli(_ args: [String]) -> Never {
  if let node = env("POD_NATIVE_CLI_NODE"), let entry = env("POD_NATIVE_CLI_NODE_ENTRY") {
    execve(node, [node, entry] + args, launcherEnvironment())
  } else if let binDir = executableDirectory() {
    let launcher = binDir + "/" + NODE_LAUNCHER_NAME
    execve(launcher, [launcher] + args, inheritedEnvironment())
  }
  writeAll(2, Array("podx: could not start the Node CLI: \(String(cString: strerror(errno)))\n".utf8))
  exit(127)
}

func execve(_ path: String, _ argv: [String], _ environment: [String]) {
  var cArgs = argv.map { strdup($0) }
  cArgs.append(nil)
  var cEnv = environment.map { strdup($0) }
  cEnv.append(nil)
  _ = Darwin.execve(path, cArgs, cEnv)
}

func inheritedEnvironment() -> [String] {
  var out: [String] = []
  var index = 0
  while let entry = environ[index] {
    out.append(String(cString: entry))
    index += 1
  }
  return out
}

/// What the bash launcher exports before it execs the CLI.
func launcherEnvironment() -> [String] {
  var environment: [String] = []
  var nodeOptions = ""
  var replModule = ""
  for pair in inheritedEnvironment() {
    if pair.hasPrefix("NODE_OPTIONS=") {
      nodeOptions = String(pair.dropFirst("NODE_OPTIONS=".count))
    } else if pair.hasPrefix("NODE_REPL_EXTERNAL_MODULE=") {
      replModule = String(pair.dropFirst("NODE_REPL_EXTERNAL_MODULE=".count))
    } else if !(pair.hasPrefix("ORCA_NODE_OPTIONS=") || pair.hasPrefix("ORCA_NODE_REPL_EXTERNAL_MODULE=")
      || pair.hasPrefix("ORCA_USER_DATA_PATH="))
    {
      environment.append(pair)
    }
  }
  environment.append("ORCA_USER_DATA_PATH=" + userDataPath())
  environment.append("ORCA_NODE_OPTIONS=" + nodeOptions)
  environment.append("ORCA_NODE_REPL_EXTERNAL_MODULE=" + replModule)
  return environment
}

/// The physical directory of this binary, so a /usr/local/bin symlink still finds its siblings.
func executableDirectory() -> String? {
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size) + 1)
  guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
  var resolved = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
  guard realpath(buffer, &resolved) != nil else { return nil }
  let path = String(decoding: resolved.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  guard let slash = path.utf8.lastIndex(of: 0x2F) else { return nil }
  return String(path[..<slash])
}

/// readOrcaCliVersion: out/package.json next to the CLI the fallback would run.
func readCliVersion() -> String? {
  let outDir: String
  if let entry = env("POD_NATIVE_CLI_NODE_ENTRY") {
    outDir = parentDirectory(parentDirectory(entry))
  } else if let binDir = executableDirectory() {
    // Contents/Resources/bin -> Contents/Resources/app.asar.unpacked/out
    outDir = parentDirectory(binDir) + "/app.asar.unpacked/out"
  } else {
    return nil
  }
  guard let bytes = readFile(outDir + "/package.json"), let root = try? parseJSON(bytes),
    let version = root["version"]?.stringValue, !version.raw.isEmpty
  else { return nil }
  return version.string
}

func parentDirectory(_ path: String) -> String {
  guard let slash = path.utf8.lastIndex(of: 0x2F) else { return path }
  return String(path[..<slash])
}
