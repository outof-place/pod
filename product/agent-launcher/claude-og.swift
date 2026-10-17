// POD_CLAUDE_OG=1 (off by default): Claude Code's Bash `grep` is answered by og, pod-search's indexed
// search, instead of the ugrep embedded in Claude's binary (agent-shell/pod-search-tool.c).
//
// Claude's shell snapshot defines `grep` as `ARGV0=ugrep "$CLAUDE_CODE_EXECPATH" <defaults> "$@"`, and
// Claude sets that variable for every Bash command it runs. The launcher gives claude ZDOTDIR and
// BASH_ENV pointing at agent-shell's startup files: the first zsh or bash under claude points the
// variable at pod-search-tool, then hands both variables back before the user's own files run.
//
// These are undocumented Claude internals. Two checks keep a Claude update from ever changing
// output: pod-search-tool hands og only a call with the exact snapshot defaults it knows, and the
// launcher turns the flag on only for a binary that embeds a ugrep version og's ugrep mode was
// checked against (pod-search harness/ugrep_diff.py). Any other build, an npm install or a wrapper
// script runs as if the flag were off. The ugrep entry is the bundled one
// (<Resources>/pod-search/ugrep-shim/ugrep), so indexed search must be installed too.
//
// pod-search-tool has no entitlements, so dyld prunes DYLD_* from it. Nothing is lost: Claude's own
// binary is hardened without allow-dyld-environment-variables, so its Bash commands never had them.

import Darwin

let claudeOgEnv = "POD_CLAUDE_OG"
// The embedded ugrep builds og's ugrep mode was checked against, as Claude's binary names them
// (NUL-delimited in its string table; 2.1.295 to 2.1.302 embed 7.8.4).
let claudeOgUgrepVersions = ["7.8.4"]

/// Whether `path` (Claude's real binary) embeds a checked ugrep. The answer is cached per path,
/// size, mtime and inode in Pod's launcher cache: a scan reads the whole binary once per build.
func embedsCheckedUgrep(_ path: String) -> Bool {
  var info = stat()
  guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size > 0 else {
    return false
  }
  let key = "\(path)\t\(info.st_size)\t\(info.st_mtimespec.tv_sec)\t\(info.st_ino)"
  // Pod's own cache folder (agent-search.swift), never pod-search's or a developer install's.
  let cacheDir = (env("HOME") ?? "") + "/Library/Caches/" + launcherCacheName
  let cache = cacheDir + "/claude-ugrep"
  if let cached = readSmallFile(cache) {
    let lines = cached.split(separator: "\n", omittingEmptySubsequences: false)
    if lines.count >= 2, lines[0] == key { return lines[1] == "ok" }
  }
  let ok = fileContainsAny(path, size: Int(info.st_size),
    needles: claudeOgUgrepVersions.map { "\0ugrep \($0)\0" })
  writeSmallFile(cache, "\(key)\n\(ok ? "ok" : "no")\n")
  return ok
}

func fileContainsAny(_ path: String, size: Int, needles: [String]) -> Bool {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  guard let base = mmap(nil, size, PROT_READ, MAP_PRIVATE, fd, 0), base != MAP_FAILED else {
    return false
  }
  defer { munmap(base, size) }
  for needle in needles {
    let bytes = Array(needle.utf8)
    if bytes.withUnsafeBytes({ memmem(base, size, $0.baseAddress, bytes.count) }) != nil {
      return true
    }
  }
  return false
}

func readSmallFile(_ path: String) -> String? {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var buffer = [UInt8](repeating: 0, count: 4096)
  let n = read(fd, &buffer, buffer.count)
  return n > 0 ? String(decoding: buffer[0..<n], as: UTF8.self) : nil
}

/// Writes through a temporary file and a rename, so a reader never sees half of it.
func writeSmallFile(_ path: String, _ text: String) {
  let dir = String(path[..<(path.lastIndex(of: "/") ?? path.startIndex)])
  mkdir(dir, 0o700)
  let temporary = "\(path).\(getpid())"
  let fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
  guard fd >= 0 else { return }
  let bytes = Array(text.utf8)
  let written = write(fd, bytes, bytes.count)
  close(fd)
  if written == bytes.count { rename(temporary, path) } else { unlink(temporary) }
}

/// `name` = `value`, with the caller's own value kept in `saveAs` (unset there when it had none).
func handOver(_ name: String, to value: String, saveAs: String) {
  // Why: already Pod's, so a claude started under claude; `saveAs` still holds the user's value.
  guard env(name) != value else { return }
  if let own = env(name) { setenv(saveAs, own, 1) } else { unsetenv(saveAs) }
  setenv(name, value, 1)
}

/// The agent-shell environment for `target` when the flag is on and it is a checked Claude build.
func applyClaudeOg(command: String, target: String) {
  guard env(claudeOgEnv) == "1", command.split(separator: "/").last == "claude",
    let real = realPath(target), let selfPath = executablePath()
  else { return }
  // <Resources>/bin/pod-agent-launcher -> <Resources>/agent-shell, <Resources>/pod-search
  var resources = selfPath.split(separator: "/", omittingEmptySubsequences: false)
  guard resources.count > 2 else { return }
  resources.removeLast(2)
  let shellDir = resources.joined(separator: "/") + "/agent-shell"
  let tool = shellDir + "/pod-search-tool"
  let entry = resources.joined(separator: "/") + "/pod-search/ugrep-shim/ugrep"
  guard isExecutableFile(tool), isExecutableFile(entry), embedsCheckedUgrep(real) else { return }
  // Why the basename: the startup files check that the snapshot runs the binary checked here.
  let version = String(real.split(separator: "/").last ?? "")
  handOver("ZDOTDIR", to: shellDir + "/zsh", saveAs: "POD_ORIG_ZDOTDIR")
  handOver("BASH_ENV", to: shellDir + "/bash/bashenv", saveAs: "POD_ORIG_BASH_ENV")
  setenv("POD_SEARCH_TOOL", tool, 1)
  setenv("POD_SEARCH_UGREP", entry, 1)
  setenv("POD_CLAUDE_OG_VERSION", version, 1)
}
