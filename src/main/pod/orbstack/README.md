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
