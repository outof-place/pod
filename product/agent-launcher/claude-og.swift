// POD_CLAUDE_OG=1 (off by default): Claude Code's Bash `grep` is answered by og, pod-search's indexed
// search, instead of the ugrep embedded in Claude's binary (agent-shell/pod-search-tool.c).
//
// Claude's shell snapshot defines `grep` as `ARGV0=ugrep "$CLAUDE_CODE_EXECPATH" <defaults> "$@"`, and
// Claude sets that variable for every Bash command it runs. The launcher gives claude ZDOTDIR and
// BASH_ENV pointing at agent-shell's startup files: the first zsh or bash under claude points the
// variable at pod-search-tool, then hands both variables back before the user's own files run.
//
// These are undocumented Claude internals, so only the builds below get it: their snapshot was read
// and their ugrep checked against og (pod-search harness/ugrep_diff.py). Any other build, an npm
// install or a wrapper script runs as if the flag were off.
//
// pod-search-tool has no entitlements, so dyld prunes DYLD_* from it. Nothing is lost: Claude's own
// binary is hardened without allow-dyld-environment-variables, so its Bash commands never had them.

import Darwin

let claudeOgEnv = "POD_CLAUDE_OG"
// Native installs are named by version (~/.local/share/claude/versions/<version>).
let claudeOgVersions: Set<String> = ["2.1.295", "2.1.296"]

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
  let version = String(real.split(separator: "/").last ?? "")
  guard claudeOgVersions.contains(version) else { return }
  // <Resources>/bin/pod-agent-launcher -> <Resources>/agent-shell
  var resources = selfPath.split(separator: "/", omittingEmptySubsequences: false)
  guard resources.count > 2 else { return }
  resources.removeLast(2)
  let shellDir = resources.joined(separator: "/") + "/agent-shell"
  let tool = shellDir + "/pod-search-tool"
  guard isExecutableFile(tool) else { return }
  handOver("ZDOTDIR", to: shellDir + "/zsh", saveAs: "POD_ORIG_ZDOTDIR")
  handOver("BASH_ENV", to: shellDir + "/bash/bashenv", saveAs: "POD_ORIG_BASH_ENV")
  setenv("POD_SEARCH_TOOL", tool, 1)
  setenv("POD_CLAUDE_OG_VERSION", version, 1)
}
