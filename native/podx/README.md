# podx (native)

Pod's `podx` and `orca` commands. A Swift binary with no Foundation that answers the commands agents
run most (browser, terminal reads, worktree reads) straight from the runtime's owner unix socket, so
a call no longer boots Electron as Node.

Everything else goes to the Node CLI unchanged: the binary execs `podx-node` (the bash launcher the
packaging keeps next to it) before it sends any request. That covers unported commands, `--help`,
flag errors, remote targets (`--host`, `--environment`, `ORCA_PAIRING_CODE`, SSH bridges) and
`POD_NATIVE_CLI=0`. Read-only lookups may run before a fallback; a mutation never does.

## Contract

Ported commands must print the same bytes and exit codes as the Node CLI and send the same requests.
Responses are re-emitted from the wire's own string and number tokens, which is what JSON.parse
followed by JSON.stringify produces for frames the runtime wrote with JSON.stringify.

## Working on it

```sh
pnpm run build:cli                      # the Node CLI the tables and the harness use
node native/podx/scripts/gen-tables.mjs # command specs and recovery tables from out/
swift build -c release --package-path native/podx
node native/podx/parity/run-parity.mjs  # Node CLI vs native against a scripted runtime
```

`run-parity.mjs --argv-file <json>` replays extra argv shapes (for example from agent transcripts)
against the same scripted runtime. Packaging: `product/native-cli/install-native-cli.cjs`.
