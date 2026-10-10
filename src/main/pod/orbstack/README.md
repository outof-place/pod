# OrbStack agent sandboxes (Pod)

An agent sandbox is an isolated OrbStack machine that Pod creates for one worktree. When the worktree's "Run Claude in the sandbox" switch is on, Pod starts that worktree's Claude launches inside the sandbox instead of on the Mac.

Each sandbox is named `pod-<worktree>-<hash>-sbx`. Pod creates and deletes only machines it recorded itself. It never touches your other OrbStack machines.

## What the sandbox sees

- **Files:** only the worktree, plus its shared git directory when the worktree is linked (`git rev-parse --git-common-dir`). Both are mounted at the same paths as on the Mac, read-write. The rest of your home folder, other repositories and `~/.claude` stay outside.
- **Credentials:** none are copied in. That covers the setup-token, `apiKeyHelper`, `ANTHROPIC_API_KEY` and the Mac's `~/.claude.json`. The sandbox gets its own `~/.claude.json`, which trusts only the mounted worktree path.
- **Network:** the sandbox is created with `orb create --isolate-network`. It reaches the internet, but not the Mac, the LAN or other OrbStack machines.
- **Hooks:** Pod's managed Claude hooks go in `/etc/claude-code/managed-settings.json`. They post agent status to `127.0.0.1:<hook port>` inside the VM. The sandbox relay (below) carries those posts to Pod's hook server.

## The sandbox relay

The relay is the sandbox's only way to the Mac:

1. When a Claude launch moves into a sandbox, Pod starts one `orb -m <sandbox> -u root python3 -I -c <relay>` process for that sandbox, or reuses it.
2. Inside the VM, the relay listens on `127.0.0.1` for a fixed list of ports. It carries each connection over the `orb run` stdin/stdout as length-prefixed frames.
3. On the Mac, Pod dials only the `127.0.0.1` ports it listed for those routes. Today that is only the hook server's port. The relay refuses any other route the VM names.
4. The launch waits up to 15 s for `/run/pod-sandbox-relay/ready` to hold this relay's nonce, so the agent's first hook post gets through.

The relay ends when the VM stops, when Pod quits, or when the sandbox is deleted.

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

The relay exposes Pod's hook server inside the VM. That server checks its hook token on every post, and each launch adds its own launch token.

Why `--isolate-network` and not a Mac firewall rule (pf):

- Without network isolation, a sandbox reaches every service on the Mac's `127.0.0.1` through `host.orb.internal`.
- OrbStack forwards those connections in userspace. On the Mac they arrive from OrbStack's own process on `lo0`, under your user ID.
- pf cannot tell them apart from the Mac's own local traffic.
- Rules inside the VM are no boundary either, because the agent has root there.

OrbStack's SSH server refuses reverse port forwards, and Unix sockets do not cross `--mount`. That leaves the stdio relay. All of this was probed on OrbStack 2.2.3.
