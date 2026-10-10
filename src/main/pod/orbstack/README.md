# OrbStack agent sandboxes (Pod)

An agent sandbox is an isolated OrbStack machine that Pod creates for one worktree. When the worktree's "Run Claude in the sandbox" switch is on, Pod starts that worktree's Claude launches inside the sandbox instead of on the Mac.

Each sandbox is named `pod-<worktree>-<hash>-sbx`. Pod creates and deletes only machines it recorded itself. It never touches your other OrbStack machines.

## What the sandbox sees

- **Files:** only the worktree, plus its shared git directory when the worktree is linked (`git rev-parse --git-common-dir`). Both are mounted at the same paths as on the Mac, read-write. The rest of your home folder, other repositories and `~/.claude` stay outside.
- **Credentials:** none are copied in. That covers the setup-token, `apiKeyHelper`, `ANTHROPIC_API_KEY` and the Mac's `~/.claude.json`. The sandbox gets its own `~/.claude.json`, which trusts only the mounted worktree path.
- **Hooks:** Pod's managed Claude hooks go in `/etc/claude-code/managed-settings.json`. They report agent status back to Pod's hook server through `host.orb.internal`.

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

## Known limitation: the Mac's localhost is reachable

The sandbox is no network boundary yet:

- A sandbox can open connections to every service on the Mac that listens on `127.0.0.1`, through `host.orb.internal`. That includes dev servers, databases and other apps' local APIs.
- Firewall rules inside the sandbox do not help, because the agent can change them.

Why a Mac firewall rule (pf) cannot close it either: OrbStack forwards these connections in userspace. On the Mac they arrive from OrbStack's own process on `lo0`, under your user ID, with `127.0.0.1` as the client. pf matches by interface or user, so it cannot tell sandbox traffic apart from the Mac's own local traffic. This was probed on OrbStack 2.2.3.

The planned fix:

- create sandboxes with `orb create --isolate-network`, which blocks the Mac, the LAN and other machines but keeps the internet (probed);
- forward exactly two ports into the sandbox's own `127.0.0.1` over an `orb run` stdio relay: Pod's hook server and the credential proxy.

Until then, treat a sandbox as file isolation only. Do not run agents in it that you would not let reach your local services.
