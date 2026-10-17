# Built-in browser commands

Use a snapshot-interact-re-snapshot loop:

```text
ORCA goto --url https://example.com --json
ORCA snapshot --json
ORCA click --element @e3 --json
ORCA snapshot --json
```

The fast way, one line per task:

- Find what to click or fill: `ORCA snapshot --interactive --json` (buttons, links and inputs with their refs; on a large page about a quarter of the full tree).
- Read one region of a large page: `ORCA snapshot --selector "<css>" --json`.
- See the page: `ORCA screenshot --save --json`, then open `result.path` with your image tool. `--save` gives each shot its own private file, so parallel agents never overwrite each other; `--path <file>` picks the name yourself. Without either the image comes back as base64, which only fills your context.
- See the whole page: `ORCA full-screenshot --save --json`. A very long, dense page can time out; scroll and take `screenshot`s then.
- Check this page at phone width: note its size (`ORCA eval --expression "innerWidth + 'x' + innerHeight" --json`), then `ORCA viewport --width 390 --height 844 --mobile --json` and `ORCA screenshot --save --json`; tablet is `--width 820 --height 1180 --mobile`. Put the noted size back with `ORCA viewport --width <w> --height <h> --json` when done, because a person watching the tab sees your viewport. The page resizes in place: no reload, its state stays.
- From an SSH worktree `--save` and `--path` are refused (they would write on the Orca host): run `ORCA screenshot --json`, decode `result.data` (base64) into a file, and open that.
- Read a value from the page: `ORCA eval --expression "<js>" --json` (the quickest command; it skips the accessibility tree).
- Wait for a change instead of sleeping: `ORCA wait --text "<text>" --json` (or `--selector`, `--url`, `--load networkidle`).
- Drive several tabs at once: `ORCA tab list --json`, then pass `--page <browserPageId>` on every command.

Common commands:

```text
ORCA goto --url <url> --json
ORCA back --json
ORCA reload --json
ORCA snapshot --json
ORCA snapshot --interactive --json
ORCA snapshot --selector <css> --json
ORCA screenshot --save --json
ORCA screenshot --path <file>
ORCA full-screenshot --save --json
ORCA full-screenshot --path <file>
ORCA viewport --width <w> --height <h> [--mobile] --json
ORCA pdf --json
ORCA click --element <ref> --json
ORCA fill --element <ref> --value <text> --json
ORCA type --input <text> --json
ORCA select --element <ref> --value <value> --json
ORCA check --element <ref> --json
ORCA scroll --direction down --amount 1000 --json
ORCA hover --element <ref> --json
ORCA focus --element <ref> --json
ORCA keypress --key Enter --json
ORCA upload --element <ref> --files <paths> --json
ORCA wait --text <text> --json
ORCA wait --url <substring> --json
ORCA wait --selector <css> --json
ORCA wait --load networkidle --json
ORCA eval --expression <js> --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --json
ORCA capture start --json
ORCA console --limit 50 --json
ORCA network --limit 50 --json
ORCA exec --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Browser commands default to the current worktree and its active tab. Use `--worktree all` only intentionally.
- For concurrent browser work, run `ORCA tab list --json`, read `tabs[].browserPageId`, and pass `--page <browserPageId>` on later commands.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Anything not listed above goes through `ORCA exec --command "<agent-browser command>"`.
- If `fill` or `type` fails on a custom input, try `ORCA focus --element @e1 --json` then `ORCA inserttext --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --json` and retry with fresh refs.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.
