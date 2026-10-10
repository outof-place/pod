"""Parity harness: runs Bash-tool commands the way Claude Code 2.1.295 spawns them,
once through the stock shell and once through a candidate shell, and compares
output bytes, exit status, cwd capture, scratch-dir side effects and leftovers.

usage: python3 -I parity.py --candidate PATH [--stock /bin/zsh] [--cases synthetic|FILE.json]
                            [--only NAME] [--repeat N] [--json OUT]

Spawn model (from the CC binary + capture shim):
  posix_spawn(shell, [shell, "-c", S]), setsid, fd0 = socketpair end (kept open, never written),
  fd1 = fd2 = task output file opened O_WRONLY|O_APPEND|O_NONBLOCK, cwd = tracked cwd.
  S = <snapshot prelude> && eval <quoted cmd> [< /dev/null] && pwd -P >| <cwdfile>
Kill model (CC #E): SIGTERM to -pgid and the ps-walked descendant tree, poll 100 ms,
  after 1500 ms SIGKILL to -pgid and the remaining tree.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Per run: concurrent runs must not share a work dir or task file.
SCRATCH = os.path.join(tempfile.gettempdir(), "pod-shell-parity", str(os.getpid()))
FIXTURE = os.path.join(SCRATCH, "fixture")
GRACE_MS = 1500
POLL_MS = 100

# ---------------------------------------------------------------- CC quoting


def _heredoc(e):
    if (
        re.search(r"\d\s*<<\s*\d", e)
        or re.search(r"\[\[\s*\d+\s*<<\s*\d+\s*\]\]", e)
        or re.search(r"\$\(\(.*<<.*\)\)", e)
    ):
        return False
    return re.search(r"""<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))""", e) is not None


def _multiline_quoted(e):
    return (
        re.search(r"'(?:[^'\\]|\\.)*\n(?:[^'\\]|\\.)*'", e) is not None
        or re.search(r'"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"', e) is not None
    )


def _sq(e):
    return "'" + e.replace("'", "'\"'\"'") + "'"


def _oo(e):
    return e if re.fullmatch(r"[A-Za-z0-9_\-./=:@%+,]+", e) else _sq(e)


def _has_input_redirect(e):
    return re.search(r"(?:^|[\s;&|])<(?![<(])\s*\S+", e) is not None


def _nul_fix(e):
    if "<" in e or "$" in e or "`" in e:
        return e
    return re.sub(r"(\d?&?>+[ \t]*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])", r"\1/dev/null", e)


def cc_eval_arg(cmd):
    ce = _nul_fix(cmd)
    devnull = not _heredoc(ce) and not _has_input_redirect(ce)
    if _heredoc(ce) or _multiline_quoted(ce):
        h = _sq(ce)
        he = h if _heredoc(ce) else (h + " < /dev/null" if devnull else h)
    else:
        he = _oo(ce) + (" < /dev/null" if devnull else "")
    if "|" in ce and devnull:
        he = _sq(ce) + " < /dev/null"
    return he


def build_s(cmd, snapshot, cwdfile):
    parts = [
        f"source {_oo(snapshot)} 2>/dev/null || true",
        "setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true",
        "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true",
        f"eval {cc_eval_arg(cmd)}",
        f"pwd -P >| {_oo(cwdfile)}",
    ]
    return " && ".join(parts)


# ---------------------------------------------------------------- process helpers


def ps_table():
    out = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,command="],
        capture_output=True,
        text=True,
        env={"LC_ALL": "C"},
    ).stdout
    rows = []
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)", line)
        if m:
            rows.append((int(m[1]), int(m[2]), int(m[3]), m[4]))
    return rows


def descendants(pid, rows=None):
    rows = rows or ps_table()
    kids = {}
    for p, pp, _, _ in rows:
        kids.setdefault(pp, []).append(p)
    seen, queue = set(), [pid]
    while queue:
        for c in kids.get(queue.pop(0), []):
            if c > 1 and c != pid and c != os.getpid() and c not in seen:
                seen.add(c)
                queue.append(c)
    return seen


def cc_tree_kill(pid, sig):
    tree = descendants(pid)
    try:
        os.killpg(pid, sig)
    except OSError:
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    for p in tree:
        try:
            os.kill(p, sig)
        except OSError:
            pass
    return tree


def tree_digest(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(
            files + [x for x in dirs if os.path.islink(os.path.join(d, x))]
        ):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root)
            if rel.endswith(".git/index"):
                continue  # stat-cache refresh content depends on copy timestamps
            if os.path.islink(p):
                out.append(f"L {rel} -> {os.readlink(p)}")
            else:
                with open(p, "rb") as fh:
                    out.append(f"F {rel} {hashlib.sha1(fh.read()).hexdigest()[:12]}")
    return out


# ---------------------------------------------------------------- one run


def reset_work(work):
    # Keep the work dir inode stable across runs: warm shells are keyed by cwd dev/ino.
    assert work.startswith(SCRATCH + os.sep)
    os.makedirs(work, exist_ok=True)
    for name in os.listdir(work):
        p = os.path.join(work, name)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
    src = FIXTURE
    for name in os.listdir(src):
        a, b = os.path.join(src, name), os.path.join(work, name)
        if os.path.isdir(a) and not os.path.islink(a):
            shutil.copytree(a, b, symlinks=True)
        else:
            shutil.copy2(a, b, follow_symlinks=False)


def build_fixture():
    sub = os.path.join(FIXTURE, "sub")
    os.makedirs(sub, exist_ok=True)
    files = {"file.txt": "hello world\nfoo\nhello again\n", "notes.txt": "notes\n", "script.sh": "SCRIPT_VAR=from-script\necho sourced\n", "zażółć.txt": "x\n"}
    for name, text in files.items():
        with open(os.path.join(FIXTURE, name), "w") as fh:
            fh.write(text)
    if not os.path.lexists(os.path.join(FIXTURE, "link")):
        os.symlink("sub", os.path.join(FIXTURE, "link"))
    repo = os.path.join(FIXTURE, "repo")
    if not os.path.isdir(repo):
        os.makedirs(repo)
        git = ["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"]
        subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True)
        with open(os.path.join(repo, "a.txt"), "w") as fh:
            fh.write("a\n")
        subprocess.run(git + ["add", "a.txt"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", "first"], check=True)
        with open(os.path.join(repo, "a.txt"), "a") as fh:
            fh.write("b\n")
        subprocess.run(git + ["commit", "-q", "-am", "second"], check=True)


def default_snapshot():
    # A stable copy of the newest Claude Code snapshot: the live one is deleted when its session exits.
    snaps = glob.glob(os.path.expanduser("~/.claude/shell-snapshots/snapshot-zsh-*.sh"))
    if not snaps:
        sys.exit("no Claude Code zsh snapshot found; pass --snapshot")
    dst = os.path.join(SCRATCH, "snapshot.zsh")
    shutil.copy(max(snaps, key=os.path.getmtime), dst)
    return dst


def run_once(shell, case, snapshot, env, tag):
    work = os.path.join(SCRATCH, "work")
    reset_work(work)
    cwd = os.path.join(work, case.get("cwd", ""))
    out_path = os.path.join(SCRATCH, "task.output")
    cwdfile = os.path.join(SCRATCH, "claude-pnb-cwd")
    for p in (out_path, cwdfile):
        if os.path.exists(p):
            os.unlink(p)
    s = build_s(case["command"], snapshot, cwdfile)
    out_fd = os.open(
        out_path, os.O_WRONLY | os.O_APPEND | os.O_NONBLOCK | os.O_CREAT, 0o644
    )
    ours, theirs = socket.socketpair()
    fa = [
        (os.POSIX_SPAWN_DUP2, theirs.fileno(), 0),
        (os.POSIX_SPAWN_DUP2, out_fd, 1),
        (os.POSIX_SPAWN_DUP2, out_fd, 2),
    ]
    run_env = dict(env)
    run_env.update(case.get("env", {}))
    t0 = time.monotonic()
    old = os.getcwd()
    os.chdir(cwd)
    try:
        pid = os.posix_spawn(
            shell, [shell, "-c", s], run_env, file_actions=fa, setsid=True
        )
    finally:
        os.chdir(old)
    theirs.close()
    os.close(out_fd)
    killed = None
    deadline = t0 + case.get("kill_after_ms", 20000) / 1000
    status = None
    term_at = None
    if case.get("block"):
        _, status = os.waitpid(pid, 0)  # exact timing for benches; no kill emulation
    while status is None:
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            status = st
            break
        now = time.monotonic()
        if term_at is None and now >= deadline:
            killed = "TERM"
            term_at = now
            cc_tree_kill(pid, signal.SIGTERM)
        elif (
            term_at is not None
            and now - term_at >= GRACE_MS / 1000
            and killed == "TERM"
        ):
            killed = "KILL"
            cc_tree_kill(pid, signal.SIGKILL)
        time.sleep(0.002 if term_at is None else POLL_MS / 1000)
    wall = (time.monotonic() - t0) * 1000
    time.sleep(case.get("settle_ms", 50) / 1000)
    ours.close()
    with open(out_path, "rb") as fh:
        output = fh.read()
    cwd_after = open(cwdfile).read() if os.path.exists(cwdfile) else None
    marker = case.get("leftover_marker")
    leftovers = []
    if marker:
        assert len(marker) >= 5, marker
        # Only our own test sleepers carry these markers; never touch anything else.
        mine = [
            (p, c)
            for p, _, _, c in ps_table()
            if marker in c and re.match(r"(sleep|python3) ", c)
        ]
        leftovers = [c for _, c in mine]
        for p, _ in mine:
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
    res = {
        "output": output,
        "exit": os.waitstatus_to_exitcode(status),
        "cwd": cwd_after.replace(work, "<WORK>") if cwd_after else None,
        "files": tree_digest(work),
        "killed": killed,
        "leftovers": len(leftovers),
        "wall_ms": wall,
    }
    return res


def normalize(case, b):
    s = b.decode("utf-8", "surrogateescape")
    for pat in case.get("normalize", []):
        s = re.sub(pat, "<N>", s)
    return s


def compare(case, a, b):
    diffs = []
    for k in ("exit", "cwd", "files", "killed", "leftovers"):
        if a[k] != b[k]:
            diffs.append((k, a[k], b[k]))
    if a["output"] != b["output"]:
        if normalize(case, a["output"]) == normalize(case, b["output"]):
            diffs.append(("output~", "normalized-equal", ""))
        else:
            diffs.append(
                (
                    "output",
                    _desc(a["output"], b["output"]),
                    _desc(b["output"], a["output"]),
                )
            )
    return diffs


SHOW = False


def _desc(x, y):
    # Never print raw output by default: mined commands may read files that hold secrets.
    at = next((i for i, (p, q) in enumerate(zip(x, y)) if p != q), min(len(x), len(y)))
    d = "len=%d sha=%s first_diff@%d" % (len(x), hashlib.sha1(x).hexdigest()[:10], at)
    if SHOW:
        d += " ctx=%r" % x[max(0, at - 40) : at + 80]
    return d


def _log_counts(log):
    try:
        t = open(log).read()
    except OSError:
        return (0, 0)
    return (t.count(" hit "), t.count(" miss "))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--stock", default="/bin/zsh")
    ap.add_argument("--cases", default="synthetic")
    ap.add_argument("--snapshot")
    ap.add_argument("--only")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--json")
    ap.add_argument("--no-prime", action="store_true")
    ap.add_argument("--prime-ms", type=int, default=60)
    ap.add_argument("--stable-check", action="store_true", help="re-run stock on diffs to drop nondeterministic cases")
    ap.add_argument("--show", action="store_true", help="print output context on diffs (synthetic cases only)")
    args = ap.parse_args()
    global SHOW
    SHOW = args.show and args.cases == "synthetic"
    if args.cases == "synthetic":
        sys.path.insert(0, HERE)
        from cases import CASES as cases
    else:
        cases = json.load(open(args.cases))
        for c in cases:
            c.setdefault("kill_after_ms", 15000)
    if args.only:
        cases = [c for c in cases if re.search(args.only, c["name"])]
    env = dict(os.environ)
    # Read-only replays must not refresh real repos' index files.
    env["GIT_OPTIONAL_LOCKS"] = "0"
    # Isolate the candidate's daemon from any live Claude Code session.
    env["CLAUDE_PID"] = str(os.getpid())
    env["POD_SHELLD_ID"] = "harness-%d" % os.getpid()
    env["POD_SHELLD_LOG"] = "1"
    tmp = env.get("TMPDIR", "/tmp/")
    log = os.path.join(tmp, "pod-shelld-%d" % os.getuid(), env["POD_SHELLD_ID"] + ".d", "shelld.log")
    hits = misses = 0
    os.makedirs(SCRATCH, exist_ok=True)
    build_fixture()
    args.snapshot = args.snapshot or default_snapshot()
    report = []
    exact = approx = bad = unstable = 0
    for case in cases:
        for _ in range(args.repeat):
            a = run_once(args.stock, case, args.snapshot, env, "stock")
            if not args.no_prime:
                prime = ": <<'PNB'\nPNB" if "< /dev/null" not in cc_eval_arg(case["command"]) else ":"
                run_once(args.candidate, {"name": "prime", "command": prime, "cwd": case.get("cwd", "")}, args.snapshot, env, "prime")
                time.sleep(args.prime_ms / 1000)
            before = _log_counts(log)
            b = run_once(args.candidate, case, args.snapshot, env, "cand")
            after = _log_counts(log)
            warm = after[0] > before[0]
            hits += warm
            misses += after[1] > before[1]
            d = compare(case, a, b)
            hard = [x for x in d if x[0] != "output~"]
            if hard and args.stable_check:
                # Re-run stock twice: nondeterministic commands (threaded rg, live dirs) vary on
                # their own; a real candidate diff reproduces against every stock run.
                alts = [run_once(args.stock, case, args.snapshot, env, "stock%d" % j) for j in (2, 3)]
                if any(compare(case, a, x) for x in alts) or any(not compare(case, x, b) for x in alts):
                    unstable += 1
                    print("%-15s %-28s" % ("UNSTABLE", case["name"]))
                    report.append({"name": case["name"], "verdict": "UNSTABLE"})
                    continue
            if not d:
                exact += 1
                verdict = "EXACT"
            elif not hard:
                approx += 1
                verdict = "NORMALIZED"
            else:
                bad += 1
                verdict = "DIFF"
            if case.get("expect_diff") and verdict == "DIFF":
                verdict = "DIFF(expected)"
            print(
                "%-15s %-28s stock %7.1f ms  cand %7.1f ms %s %s"
                % (
                    verdict,
                    case["name"],
                    a["wall_ms"],
                    b["wall_ms"],
                    "warm" if warm else "COLD",
                    "" if not d else repr(d)[:400],
                )
            )
            report.append(
                {
                    "name": case["name"],
                    "verdict": verdict,
                    "stock_ms": a["wall_ms"],
                    "cand_ms": b["wall_ms"],
                    "diffs": [x[0] for x in d],
                }
            )
    print(
        f"\nexact {exact}  normalized {approx}  diff {bad}  unstable {unstable}  of {exact + approx + bad + unstable}"
    )
    print(f"candidate warm hits {hits}, misses {misses}")
    if args.json:
        json.dump(report, open(args.json, "w"), indent=1)
    shutil.rmtree(SCRATCH, ignore_errors=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
