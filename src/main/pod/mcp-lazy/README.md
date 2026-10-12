# Lazy-start heavy MCP servers (fork-only)

Claude Code starts every stdio MCP server in `~/.claude.json` with every session. The podSettings key `mcpLazyStart` (`{ enabled, servers }`, off by default) puts the chosen user-scope servers behind `mcp-lazy`. The real server then starts at the session's first tool call instead.

## The shim

The shim's source is `native/mcp-lazy-macos/src/mcp-lazy.c`. It is one C file using libSystem only.

- **Build and signing:** `product/mcp-lazy/install-mcp-lazy.cjs` builds it in afterPack into `Contents/Resources/bin`. It is signed with no entitlements: dyld strips `DYLD_*` from its environment, so servers started through it don't get them.
- **Before the first tool call:** it answers the handshake (`server/discover`, `initialize`), the lists, and recorded `ping` and `logging/setLevel` answers from a manifest. The answers are byte for byte; only the request id is spliced in.
- **At the first tool call:** it starts the server with the session's own `initialize`, then passes every frame through unchanged.
- **Manifest:** one per server identity: the binary, the args and the nearest `package.json`. It is kept in `~/Library/Caches/mcp-lazy`, with the log in `~/Library/Logs/mcp-lazy.log`.
- **When the server answers differently:** the manifest is dropped and the session gets `tools/list_changed`.
- **Failures:** a server that can't start gives a JSON-RPC error, not a hang.
- **Shutdown:** the server's process group goes away with the session.

## The setting

- **Shim copy:** the runtime copies the shim beside the managed hooks (`getSharedManagedScriptPath`), so app moves and updates keep it.
- **Wrapping:** it rewrites a chosen entry to `/bin/sh -c '<run the shim if present, else the original>' <name> <original command…>`, keeping `env` as it was. Without Pod or the shim, the original server runs. Unwrapping restores the entry exactly, because the original command line rides in the arguments.
- **Writing:** writes go only through `claude mcp remove/add-json -s user`, never into the file directly.
  - A 0600 backup in userData (`mcp-lazy/backups`) comes first.
  - Afterwards a check confirms that only the planned entries changed; anything else puts them back.
- **Startup vs change:** at startup it only wraps. Two Pods with different settings would otherwise undo each other on every launch. A change of the setting also unwraps.
- **RPC:**
  - `podMcpLazy.status` lists the user-scope stdio servers with their state. For the ones now running under a `claude` process it also gives the measured cost per session (top's MEM).
  - `podMcpLazy.restoreBackup` turns the setting off and gives every wrapped entry back the one in the newest backup.
- **Scope:** only `~/.claude.json`. Pod's Claude profiles (`CLAUDE_CONFIG_DIR`) come later.
