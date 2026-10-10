# Claude Code Bash tool: how commands reach the shell, and why Pod keeps the stock path

Status: reference. The warm-shell prototype in `native/shell-warm-darwin/` is a documented
NO-GO. It is kept for its parity harness and as a record of what was measured. Nothing in
packaging or `pod-agent-launcher` uses it.

## How Claude Code runs a Bash tool call (2.1.295)

Read from the CLI's embedded source and confirmed with a capture shim:

- Spawn: `shellPath -c S`, detached (own session and process group), stdin a socketpair Claude
  never writes and keeps open, stdout and stderr one shared fd on the task output file
  (`O_WRONLY|O_APPEND|O_NONBLOCK`). There is no `-l` once a snapshot exists.
- `S` is a single line:
  `source <snapshot> 2>/dev/null || true && [optional env parts] && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval <quoted command> [< /dev/null] && pwd -P >| /tmp/claude-XXXX-cwd`.
  - `< /dev/null` is left out when the command has a heredoc or its own `<` redirect. Such
    commands read the open, silent socket.
  - The cwd file is written only when the command succeeds. Claude then validates the path
    before the next call uses it.
  - Optional env parts: a TMPDIR backstop, plugin `bin/` PATH entries, `BUN_OPTIONS` on remote,
    `GIT_CONFIG_PARAMETERS`, credential and session-env scripts, sandbox TMPDIR.
- Snapshot: made once per Claude process, at the first Bash call, by running `shellPath -c -l`.
  That shell is not interactive. It sources `~/.zshrc` and dumps functions, options, aliases and
  PATH, then appends Claude's own `rg`/`find`/`grep`/`pkill` shims. The file is deleted when the
  process exits. In-process teammates share it.
- Kill: SIGTERM to `-pgid` and to the descendant tree found by walking parent pids, then SIGKILL
  after a 1.5 s grace period. A foreground command that times out is moved to the background,
  not killed.
- Knobs:
  - `CLAUDE_CODE_SHELL` is accepted when the path contains `zsh` or `bash` and is executable.
    Claude then spawns it directly.
  - `CLAUDE_CODE_SHELL_PREFIX` runs `zsh -c "<prefix> '<S>'"`, so zsh still starts first, and
    it also wraps hooks, the status line and MCP startup. It cannot make the shell faster.

Trap: Claude chooses bash or zsh quoting with `path.includes("bash")`, checked first. A zsh
replacement whose path contains "bash" anywhere (`.../pod-native-bash/zsh`) gets bash `shopt`
lines and a bash-style snapshot. Keep shell binaries on paths without that substring.

## Where the time goes

For a trivial call in a busy lead session, almost all of the time is spent in the Claude
process before the spawn and after the exit (hooks, event loop). The shell's own startup is a
small slice, about as large as the `rtk` wrapper process. Exact figures are kept with the team,
not in this repository.

## The warm-shell prototype (NO-GO)

- A client named `zsh` is used as `CLAUDE_CODE_SHELL`. It accepts only the exact template above
  and execs `/bin/zsh` unchanged for everything else: snapshot creation, the env probe, sandbox,
  and unknown shapes.
- A per-Claude-process daemon, double-forked from the first client, keeps `/bin/zsh` processes
  pre-started.
  - Each one has the request's exact env, cwd (dev/ino), umask, signal mask, ignored signals
    and QoS, and is a session leader.
  - The snapshot prelude has already run.
  - Double forking keeps the daemon in Claude's responsibility and coalition, but outside the
    tree Claude kills.
- On a request, the warm shell:
  - opens the task file by path with Claude's flags;
  - checks the opened fd's device and inode against the client's fd 1;
  - unloads its modules, unsets its variables and resets `SECONDS`;
  - runs `: "${$(< cmdfile)%.}" && eval "$_"`. The command arrives in `$_`, so no variable and
    no extra eval frame are visible.
- Signals are relayed. When the client dies, the command tree gets SIGKILL. If the daemon is lost
  after it took a command, the client fails rather than re-running the command.

Parity against stock, using the harness below:

- Every synthetic case is byte-identical except three intended differences:
  `$ZSH_EXECUTION_STRING`, the `$PPID` value and the parent process name.
- No mined read-only command differed because of the warm shell. The only differences were also
  present stock against stock: Claude's multithreaded `ugrep`/`bfs` shims order output
  nondeterministically.

Why NO-GO: the warm shell moves zsh startup off the critical path but does not remove it, and it
adds a client exec plus the IPC on top. Total CPU per call goes up by more than the latency goes
down. That is a net loss on a fleet machine that is already CPU-bound. The delays that matter are
on the hub side, before the spawn and after the exit.

A safe canary, if this is ever revived: never re-run a user command through the stock path to
compare, since side effects would repeat. Instead, every Nth spawn, run a fixed probe command in
a warm shell and in a stock shell with the same key. The probe digests options, parameter names,
function bodies, aliases, env, umask, limits, traps, loaded modules, the fd list, the eval
context, `$_`, `$?`, `$#` and `$0`. Compare the digests, log only match or mismatch, and disable
the pool after repeated mismatches.

## Recommended instead: interactive-only completions

Pod sets no shell options for agents. The cheap win sits in the user's own `~/.zshrc`: load
completion scripts (nvm `bash_completion`, bun `_bun`, generated completions) only under
`[[ -o interactive ]]`. The snapshot shell is not interactive, so the snapshot no longer carries
compinit, compdef, bashcompinit or the completion helpers. It keeps PATH, functions such as
`nvm`, and Claude's shims. Snapshot creation and every Bash call's prelude get cheaper, and
interactive terminals keep their completions.

Side effect: zsh's compaudit defines a `getent` fallback function. macOS has no `getent`, so
agents' shells no longer have one either.

## Parity harness

`native/shell-warm-darwin/parity/` spawns commands exactly as Claude does and compares output
bytes, exit status or signal, the cwd file, side effects in the scratch dir, and leftover
processes. The candidate can be any shell path; `/bin/zsh` against itself is the baseline.

- `parity.py --candidate PATH [--cases FILE] [--stable-check] [--show]` uses the synthetic cases
  in `cases.py` by default.
- `mine.py` extracts read-only command shapes from local transcripts into a temp file outside
  the repository.
- `bench.py` measures interleaved latency.
- Kill cases emulate Claude's TERM-then-KILL tree kill. Read-only replays set
  `GIT_OPTIONAL_LOCKS=0` and strip `rtk`, which writes its own database.
