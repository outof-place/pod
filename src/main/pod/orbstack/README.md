# OrbStack agent sandboxes (Pod)

An agent sandbox is an isolated OrbStack machine that Pod creates for one worktree. When the worktree's "Run Claude in the sandbox" switch is on, Pod starts that worktree's Claude launches inside the sandbox instead of on the Mac.

Each sandbox is named `pod-<worktree>-<hash>-sbx`. Pod creates and deletes only machines it recorded itself. It never touches your other OrbStack machines.

## What the sandbox sees

- **Files:** only the worktree, plus its shared git directory when the worktree is linked (`git rev-parse --git-common-dir`). Both are mounted at the same paths as on the Mac, read-write. The rest of your home folder, other repositories and `~/.claude` stay outside.
- **Credentials:** none are copied in. That covers the setup-token, `apiKeyHelper`, `ANTHROPIC_API_KEY` and the Mac's `~/.claude.json`. The sandbox gets its own `~/.claude.json`, which trusts only the mounted worktree path. When a credential source is on, Claude Code's API calls get the credential on the Mac (see the `anthropic-api` route below).
- **Network:** the sandbox is created with `orb create --isolate-network`. It reaches the internet, but not the Mac, the LAN or other OrbStack machines.
- **Privacy:** the Mac's Claude Code privacy and traffic switches are copied into each sandboxed launch. They are read at every launch from the process env, `~/.claude/settings.json` and the managed settings' `env` blocks: `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_ERROR_REPORTING`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK` and the like. When they turn telemetry or feature flags off, the `anthropic-api` route also refuses `/api/event_logging` or `/api/eval` for that sandbox.
- **Hooks:** Pod's managed Claude hooks go in `/etc/claude-code/managed-settings.json`. They post agent status to `127.0.0.1:<hook port>` inside the VM. The sandbox relay (below) carries those posts to Pod's hook server.

## The sandbox relay

The relay is the sandbox's only way to the Mac. It carries Claude hook posts and nothing else:

1. When a Claude launch moves into a sandbox, Pod starts one `orb -m <sandbox> -u root python3 -I -c <relay>` process for that sandbox, or reuses it.
2. Inside the VM, the relay listens on `127.0.0.1:<hook port>` only. It carries each connection over the `orb run` stdin/stdout as length-prefixed frames.
3. On the Mac, Pod reads one HTTP request per connection and checks it before anything is dialed:
   - it must be `POST /hook/claude` with a `Content-Length` body of at most 1 MiB;
   - it must carry the sandbox's own hook token.
     Anything else gets a 4xx answer from the relay itself.
4. A request that passes goes to Pod's hook server on the Mac's `127.0.0.1`. The relay replaces the sandbox token with the hook server's token and adds `Connection: close`.
5. The launch waits up to 15 s for `/run/pod-sandbox-relay/ready` to hold this relay's nonce, so the agent's first hook post gets through.

The sandbox token has 32 random bytes and lives only in Pod's memory. It is never written to the Mac's disk:

- Pod mints it when the sandbox is created, or at the first launch after a Pod restart.
- Deleting the sandbox revokes it, and quitting Pod discards it.
- The VM gets it as `ORCA_AGENT_HOOK_TOKEN`. The hook server's own token never enters the VM.

The relay process ends when the sandbox is deleted, when Pod quits, or when the VM stops. A Pod crash closes the relay's stdin, which ends it too. The real-OrbStack tests check that no `orb` process for the machine survives a delete.

## The `anthropic-api` route

This second route kind lets the sandbox's Claude Code use a credential that never enters the VM. Claude Code still talks to `https://api.anthropic.com` as it does on the Mac: no `ANTHROPIC_BASE_URL`, no proxy variable. The route is off while the credential source is the stub, which is all Pod ships until you choose between an API key and an OAuth login.

While a source is on:

1. The relay pins `api.anthropic.com` to `127.0.0.1` and `::1` in the VM's `/etc/hosts`, inside a marked block, and listens on port 443 on both loopbacks. All other hosts still resolve and connect directly over the VM's internet.
2. Pod makes a CA for the sandbox, in memory only. The CA may sign only `api.anthropic.com` (a critical name constraint). It signs exactly one leaf certificate for that name, and its private key is discarded as soon as it has. The VM gets only the CA certificate, at `/etc/pod-sandbox/anthropic-ca.pem`.
3. The agent's launch sets `NODE_EXTRA_CA_CERTS` to that file. It also sets a placeholder credential: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` for an OAuth source. The placeholder works against nothing.
4. On the Mac, TLS ends in Pod's own process: there is no listening port. Any server name other than `api.anthropic.com` fails the handshake.
5. Pod forwards only the endpoints Claude Code uses: `/v1/messages`, token counting, models, its server-managed settings and policy limits, feature flags, bootstrap config, telemetry, the MCP registry, and the `/api/hello` warm-up. Paths with dot segments, empty segments or escapes are refused, and so is anything else, with a 403.
6. Pod drops the VM's `Authorization`, `x-api-key`, `Cookie` and proxy headers, adds the credential source's headers, and sends the request to the real `api.anthropic.com:443` with normal certificate verification. Responses stream back unchanged, including SSE.

The CA, its leaf and the route die with the sandbox. A relay that starts without the route removes the pin and the CA file, and so does a relay that exits.

This was verified with a real request:

- Claude Code 2.1.287's native binary, in a sandbox, against a stub API on the Mac. The stub has its own CA, and no real token was used.
- Without `NODE_EXTRA_CA_CERTS`, Claude Code refused the Mac's certificate and nothing reached the stub.
- With it, the answer came through, and the stub saw only Pod's key. So Claude Code does not pin certificates.
- In interactive mode, Claude Code asks once per sandbox to approve a custom API key.

## How Claude Code gets in

The sandbox runs the Mac's Claude Code version, so its hook events match what Pod expects. If the Mac has no Claude Code, the sandbox gets the stable channel. The sandbox's auto-updater is off.

Pod never pipes `install.sh` into a shell:

1. Pod downloads the release from `downloads.claude.ai/claude-code-releases/<version>`. It fetches four files: `manifest.json`, its detached signature `manifest.json.sig`, the zstd build for the Mac's architecture, and the release key from `downloads.claude.ai/keys/claude-code.asc`.
2. On the Mac, Pod checks the compressed build against `manifest.zst.json` and the decompressed binary against `manifest.json`.
3. Pod caches the verified files under `<userData>/pod-orbstack/claude-releases/<version>/<platform>/`. A second sandbox on the same version reuses them. Other versions are pruned after a day.
4. Pod copies the files into the new sandbox with `orb push`.
5. Inside the sandbox, `gpgv` checks the manifest signature. The signing key must have the fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE` that Anthropic publishes. Then the sandbox checks the manifest's version and the binary's SHA-256.
6. Only after both checks pass does the binary go into the native installer's layout (`~/.local/share/claude/versions/<version>`, linked from `~/.local/bin/claude`).

Releases older than 2.1.89 publish no signature, so Pod refuses them.

## Templates

A Pod machine is cloned from a stopped template machine (`orb clone`, which copies data on demand), so a create skips the image, apt and the Claude Code install:

- **Sandbox template** `pod-sbx-<hash>-tmpl`: isolated, with `--isolate-network`, git and the verified Claude Code of one version, and no mounts. A clone gets the worktree mounts (`orbctl config set|add machine.<name>.mounts`) and starts. Then only the per-worktree steps run: the mount checks, the hook script, the trusted worktree and the managed settings. A clone whose `orb info` does not show `isolated` and `isolate_network` is deleted and built the full way.
- **Shared template** `pod-vm-<hash>-tmpl`: a plain Ubuntu machine with git, for the built-in recipe only. A `recipe.json` override keeps its own lifecycle.
- **Key and refresh:** the key is the image, the kind, the Claude Code version and a provisioning version. The first create builds the template, then clones it. A newer template replaces the older one of its kind; clones keep working, because they do not depend on their template. One minute after Pod starts, Pod refreshes the templates for the kinds that already have machines (for example after the Mac's Claude Code moved), and only while OrbStack runs.
- **Update in place:** when only the Claude Code version moved, Pod renames the older sandbox template to the new name instead of building another machine. It then starts the template, checks that it is still isolated, pushes, verifies and installs the new release, deletes the old version, seals the template again and stops it. Why: every new OrbStack machine takes a fresh address, and OrbStack 2.2.3 keeps a deleted machine's address for about a day (orbstack/orbstack#2688), so a few hundred creates use up the pool. A renamed machine keeps its MAC and IPv4. If the rename or the update fails, Pod deletes the renamed machine and the create builds the full way. A rename or a delete of a template waits for any `orb clone` that is reading it. The unit tests run the update on a fake `orb` that gives each create or clone a fresh address and keeps it across a rename. The opt-in `pod-orbstack-rename-address-real.test.ts` (`POD_E2E_ORBSTACK=1 POD_E2E_ORBSTACK_MACHINE=pod-test-<name>`) checks that rename on a real, already existing machine: the MAC and the IPv4 survive stop, rename and start. It creates, clones and deletes nothing, because the address pool is the user's too, and it renames the machine back afterwards.
- **Records:** templates are recorded in `<userData>/pod-orbstack/templates.json`, not in `registry.json`, so an older Pod still reads its registry. Pod deletes only recorded templates with that name shape.
- **Off:** Settings › OrbStack (`orbstack.setTemplates {enabled: false}`, stored in `templates.json`, default on) deletes every template; creates then build in full. `POD_ORBSTACK_TEMPLATES=0` turns templates off for the process. E2E profiles opt in with `POD_E2E_ORBSTACK_TEMPLATES=1`, because a template outlives its profile.
- **Nothing per sandbox in a template:** before a template stops, Pod empties its `/etc/machine-id` (each clone's first boot mints its own) and deletes any SSH host keys (the per-worktree step regenerates them if an image runs sshd). A template never ran a launch, so it holds no `~/.claude*`, no `/etc/pod-sandbox`, no hosts pin and no trust entry. The hook token, the CA and the credential placeholder (`pod-sandbox-no-credential-<random>`) are minted per sandbox, in memory. The opt-in `pod-orbstack-clone-security-real.test.ts` checks a bare clone of the template holds none of these, and two sandboxes cloned from one template share no machine-id, CA, host key, token or placeholder.

Measured on OrbStack 2.2.3 (Claude Code 2.1.296, load average 8–25, `POD_E2E_ORBSTACK_TIMING=1`, internal numbers):

|                                         | full build                                                                 | from the template                   |
| --------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- |
| sandbox create                          | p50 22.1 s (20.1–32.4: `orb create` ~10 s, apt git 6–14 s, push 2.6–7.8 s) | p50 0.25 s (0.25–0.27)              |
| worktree machine create                 | p50 16.9 s (16.5–21.8)                                                     | p50 0.26 s (0.25–0.29)              |
| first create, template built on the way |                                                                            | 17–22 s (sandbox), 16–19 s (shared) |

- **Agent start** in a sandbox, launch command to the first Claude Code screen in a pty that answers terminal queries: p50 ~200 ms with the relay starting alongside, ~140 ms with it already up; `claude --version` 30–40 ms. The relay is ready 30–40 ms after it starts. A finer relay-wait loop (10 ms steps) did not measurably change this, and nor would a pre-started relay outside the first launch per sandbox, so neither ships.
- **Terminal queries:** `orb` on a terminal sends OSC 11 and a cursor position request and waits **5 s** for each unanswered one before it runs the command. Pod's terminals answer, but a client that renders without answering stalls every `orb -m` pane that long.
- **From 0.55 s to 0.25 s:** the per-worktree steps run as one `orb run` instead of five (−130 ms), and the release cache trusts a Claude Code binary whose inode, size, mtime and ctime match its last full SHA-256 check instead of hashing 240 MB on every create (−130 ms). What is left is `orb start` (~75 ms), the first exec in a fresh machine (~100 ms), `orb clone` (~33 ms) and two `orb info` calls.
- **First prompt:** a worktree machine's shell prompt shows ~23 ms after `orb -m` starts, so create to first prompt is ~0.28 s.
- **Warm pool:** cloning a stopped template takes 31–34 ms, renaming a stopped spare 36 ms, so a pool saves nothing. A running spare would skip `orb start` and the first exec, but mounts apply only at a (re)start, which takes ~330 ms. There is no pool.
- **File sharing:** OrbStack exposes no cache settings for VirtioFS mounts. On a 35,769-file worktree, `git status` takes ~165 ms on the Mac, ~265 ms in the VM over the mount (2.9 s cold) and ~34 ms on the VM's own disk; `rg` takes ~0.4–0.5 s on the Mac, 1.3–1.8 s over the mount and ~45 ms on the VM's own disk. The mount stays: the agent edits the Mac's files in place.

## Native clients

The orbstack.* runtime methods serve Settings › OrbStack and PodNative alike:

- `orbstack.status {containers?}`: `containers: false` skips `docker ps` and `docker stats`. Templates are listed apart from machines, with `diskBytes`, and `templatesEnabled` reports the switch.
- `orbstack.stats {names?}`: per running Pod machine (templates excluded), `cpuUsageUsec` (cgroup `cpu.stat`, cumulative), `memoryBytes` (`memory.current` minus `inactive_file`), `memoryLimitBytes` (`memory.max`, null when unlimited) and `diskBytes` (`orb info`, cached 30 s). One tick runs at most every 2 s and callers inside it share its reads; each read is one `orb run` with a 3 s timeout. A machine Pod is starting, stopping, creating or deleting is skipped, because `orb run` would start a stopped one. Clients poll it only while their OrbStack panel is visible and the app is active.
- `orbstack.subscribe` (stream) and `orbstack.unsubscribe {subscriptionId}`: `ready` (with the relay log so far, from a 256-row ring in memory), `changed` (any orbstack change: re-read the status), `progress` (create steps in plain words), `relay` (new log rows) and `end`. `changed` and `relay` reach each subscriber at most once per 250 ms.
- `orbstack.create` and `orbstack.start` explain a machine OrbStack gave no address. orb says "machine didn't start in 30s (missing IP address)"; Pod answers `{ok: false, reason: 'out-of-addresses', error: <Pod's sentence>, detail: <orb's line>}`. OrbStack 2.2.3 keeps the address of every machine it deleted, so a few hundred creates (clones and sandboxes count) exhaust its machine network (orbstack/orbstack#2688, fixed after 2.2.3). On 2026-10-11 the first create after an `orbctl stop` + `start` still failed, so the sentence also says to update OrbStack.
- `orbstack.restart`: `orbctl stop`, then `orbctl start` (2 and 3 min timeouts). It refuses while Pod is creating, deleting or starting a machine, and ends Pod's stats readers first. It stops every running container and machine on the Mac, not only Pod's, so clients ask first and show what runs: Settings › OrbStack offers it from the out-of-addresses toast, PodNative from the Machines pane.
- A relay log row holds the machine, the route, the method, the path, the status, the bytes each way, the time and why it was refused (`token`, `path`, `size`, `method`, `malformed`, `credential`, `upstream`). Method and path are Pod's own words: a standard method or `OTHER`, and the allowlisted endpoint's name (`/hook/claude`, `/v1/messages`, `/api/claude_code/…`) or `-`. No header, body, query, token or key material reaches a row; `pod-orbstack-relay-log.test.ts` checks every event for them as text, base64 and hex.

## What still gets out

Agents in the sandbox reach the internet directly. Code they can read in the worktree can therefore leave the Mac.

The localhost gap below closes only for sandboxes with network isolation:

- Every sandbox Pod creates now gets `--isolate-network`.
- A sandbox created before that still reaches the Mac's localhost. Pod no longer runs agents in it, and Settings asks you to delete and recreate it.

Why `--isolate-network` and not a Mac firewall rule (pf):

- Without network isolation, a sandbox reaches every service on the Mac's `127.0.0.1` through `host.orb.internal`.
- OrbStack forwards those connections in userspace. On the Mac they arrive from OrbStack's own process on `lo0`, under your user ID.
- pf cannot tell them apart from the Mac's own local traffic.
- Rules inside the VM are no boundary either, because the agent has root there.

OrbStack's SSH server refuses reverse port forwards, and Unix sockets do not cross `--mount`. That leaves the stdio relay. All of this was probed on OrbStack 2.2.3.
