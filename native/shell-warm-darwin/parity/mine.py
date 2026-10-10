"""Mine Bash tool commands from recent transcripts and keep only SAFE read-only shapes.

usage: python3 -I mine.py [--days 14] [--out mined.json] [--max 3000]

Output cases are run by parity.py inside the scratch fixture copy (cwd = fixture),
so paths that do not exist there just produce identical errors on both sides.
The filter is deliberately strict: an allowlist of read-only programs per pipeline
stage, no output redirection except to /dev/null, no substitutions, no env writes.
"""

import argparse
import collections
import glob
import json
import os
import re
import shlex
import tempfile
import time

READ_ONLY = {
    "echo",
    "printf",
    "pwd",
    "true",
    "false",
    "test",
    "[",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "fd",
    "file",
    "stat",
    "du",
    "df",
    "which",
    "type",
    "command",
    "whence",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "date",
    "uname",
    "seq",
    "expr",
    "jq",
    "column",
    "nl",
    "fold",
    "rev",
    "od",
    "xxd",
    "hexdump",
    "shasum",
    "md5",
    "cksum",
    "comm",
    "diff",
    "cmp",
    "tree",
    "id",
    "whoami",
    "hostname",
    "sw_vers",
    "awk",
    "sed",
    "find",
    "git",
    "sleep",
    "wait",
    "tac",
    "paste",
    "join",
    "expand",
    "unexpand",
    "strings",
    "less",
    "more",
    "base64",
    "cd",
    "ulimit",
    "umask",
}
GIT_READ = {
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "ls-files",
    "describe",
    "blame",
    "shortlog",
    "rev-list",
    "cat-file",
    "ls-tree",
    "merge-base",
    "for-each-ref",
    "name-rev",
    "grep",
    "count-objects",
}
# Subcommands that are read-only only with these exact argument shapes.
GIT_SHAPED = {
    "branch": re.compile(
        r"^(\s+(--show-current|-a|-r|-v|-vv|--list|--all|--remotes|--no-color|--sort=\S+|--contains|--merged|--no-merged|--format=\S+))*$"
    ),
    "remote": re.compile(r"^(\s+-v)?$"),
    "tag": re.compile(
        r"^(\s+(-l|--list|--sort=\S+|--points-at|-n\d*))*(\s+'?[^-\s]\S*'?)?$"
    ),
    "config": re.compile(
        r"^\s+(--get|--get-all|--get-regexp|--list|-l|--show-origin|--local|--global|--name-only)(\s+\S+)*$"
    ),
    "worktree": re.compile(r"^\s+list(\s+--porcelain)?$"),
    "stash": re.compile(r"^\s+(list|show)(\s+\S+)*$"),
    "reflog": re.compile(r"^(\s+(show|-n\s*\d+|--date=\S+|-\d+))*$"),
}
BAD = re.compile(
    r"(\$\(|`|<\(|>\(|\beval\b|\bexec\b|\bsource\b|\bkill|\brm\b|\bmv\b|\bcp\b|\btee\b|\bsudo\b|\bcurl\b|\bwget\b|\bssh\b|\bopen\b|\bosascript\b|\bxargs\b|-delete\b|-exec\b|-execdir\b|-ok\b|\bsed\b[^|;&]*\s-i|\bawk\b[^|;&]*(system|>|getline|\bprint\s*>)|\bln\b|\bchmod\b|\btouch\b|\bmkdir\b|\bnpm\b|\bpnpm\b|\byarn\b|\bnpx\b|\bmake\b|\bclaude\b|\borca\b|\bpod\b|\blaunchctl\b|\bdefaults\b|\bpkill\b|\btrash\b|\bsecurity\b)"
)
REDIR = re.compile(r"(?<![0-9&])>(?!&)|[0-9]>(?!&|/dev/null)|&>(?!/dev/null)")


def safe(cmd):
    if len(cmd) > 2000 or "\n" in cmd.strip() and "<<" not in cmd:
        return False
    if BAD.search(cmd):
        return False
    stripped = re.sub(r"[0-9]?>\s*/dev/null|2>&1|>&2|&>/dev/null", "", cmd)
    if REDIR.search(stripped):
        return False
    if "<<" in cmd:
        return False
    for seg in re.split(r"\|\||&&|[|;&]", stripped):
        seg = seg.strip().lstrip("(").rstrip(")").strip()
        if not seg:
            continue
        try:
            toks = shlex.split(seg)
        except ValueError:
            return False
        while toks and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]):
            toks = toks[1:]
        if not toks:
            continue
        prog = os.path.basename(toks[0])
        if prog == "rtk":
            toks = toks[1:]
            if toks and toks[0] == "proxy":
                toks = toks[1:]
            if not toks:
                return False
            prog = os.path.basename(toks[0])
        if prog not in READ_ONLY:
            return False
        if prog == "git":
            # skip global options, including `-C path` / `-c k=v` pairs
            args = toks[1:]
            i = 0
            while i < len(args) and args[i].startswith("-"):
                i += 2 if args[i] in ("-C", "-c") else 1
            sub = args[i] if i < len(args) else None
            rest = "".join(" " + t for t in args[i + 1 :])
            if sub in GIT_SHAPED:
                if not GIT_SHAPED[sub].match(rest):
                    return False
            elif sub not in GIT_READ:
                return False
            if any(t.startswith(("--output", "-o")) for t in args[i + 1 :]) and sub in (
                "diff",
                "log",
                "show",
            ):
                return False
        flags = [t for t in toks[1:] if t.startswith("-")]
        plain = [t for t in toks[1:] if not t.startswith("-")]
        if prog in ("sort", "tree") and any(
            t.startswith("-o") or t == "--output" for t in flags
        ):
            return False
        if prog == "uniq" and len(plain) > 1:
            return False
        if prog == "rg" and any(t.startswith("--pre") for t in flags):
            return False
        if prog == "fd" and any(
            t in ("-x", "-X", "--exec", "--exec-batch") for t in flags
        ):
            return False
        if prog == "sed" and re.search(
            r"(^|[;/}\s])[wW]\s|/w\b|\be\b", " ".join(plain)
        ):
            return False
        if prog == "sleep" and any(
            not re.fullmatch(r"[0-1](\.\d+)?", t) for t in plain
        ):
            return False
        if prog == "find" and any(
            t in ("-delete", "-exec", "-execdir", "-ok", "-fprint", "-fls")
            for t in toks
        ):
            return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument(
        "--out",
        # Outside the repo: these are the user's own commands.
        default=os.path.join(tempfile.gettempdir(), "pod-shell-parity-mined.json"),
    )
    ap.add_argument("--max", type=int, default=3000)
    args = ap.parse_args()
    cutoff = time.time() - args.days * 86400
    files = [
        f
        for f in glob.glob(
            os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True
        )
        if os.path.getmtime(f) >= cutoff
    ]
    stats = collections.Counter()
    seen = set()
    kept = set()
    keep = []
    for f in files:
        try:
            fh = open(f, errors="replace")
        except OSError:
            continue
        for line in fh:
            if '"Bash"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            m = o.get("message")
            if not isinstance(m, dict):
                continue
            for c in m.get("content") or []:
                if (
                    not isinstance(c, dict)
                    or c.get("type") != "tool_use"
                    or c.get("name") != "Bash"
                ):
                    continue
                inp = c.get("input") or {}
                cmd = inp.get("command")
                if not isinstance(cmd, str):
                    continue
                stats["bash_calls"] += 1
                if inp.get("run_in_background"):
                    stats["background"] += 1
                if "<<" in cmd:
                    stats["heredoc"] += 1
                if re.search(r"(^|[;&|]\s*)cd\s", cmd):
                    stats["has_cd"] += 1
                if "|" in cmd:
                    stats["pipe"] += 1
                if cmd.startswith("rtk "):
                    stats["rtk_prefixed"] += 1
                if cmd in seen:
                    continue
                seen.add(cmd)
                if safe(cmd):
                    # rtk writes its tracking DB outside the scratch dir: replay the native command.
                    cmd = re.sub(r"(^|(?<=[\s;&|(]))rtk (proxy )?", "", cmd)
                    if cmd in kept:
                        continue
                    kept.add(cmd)
                    stats["safe_unique"] += 1
                    keep.append(
                        {
                            "name": "mined_%04d" % len(keep),
                            "command": cmd,
                            "normalize": [r"\b\d{2,7}\b"],
                        }
                    )
    stats["unique"] = len(seen)
    stats["files"] = len(files)
    keep = keep[: args.max]
    json.dump(keep, open(args.out, "w"), indent=0)
    print(json.dumps(stats, indent=1))
    print("wrote", len(keep), "cases to", args.out)


if __name__ == "__main__":
    main()
