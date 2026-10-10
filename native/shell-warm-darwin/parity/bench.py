"""Latency bench: stock /bin/zsh vs candidate, spawned exactly like Claude Code does,
interleaved, with an idle gap between calls (agents think between Bash calls).

usage: python3 -I bench.py --candidate PATH [-n 200] [--gap-ms 60] [--cmd 'echo hi']
"""

import argparse
import os
import resource
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parity


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, int(len(v) * q))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--stock", default="/bin/zsh")
    ap.add_argument("-n", type=int, default=200)
    ap.add_argument("--gap-ms", type=int, default=60)
    ap.add_argument("--cmd", default="echo hi")
    args = ap.parse_args()
    env = dict(os.environ)
    env["CLAUDE_PID"] = str(os.getpid())
    env["POD_SHELLD_ID"] = "bench-%d" % os.getpid()
    env["POD_SHELLD_LOG"] = "1"
    print("daemon key", env["POD_SHELLD_ID"])
    os.makedirs(parity.SCRATCH, exist_ok=True)
    parity.build_fixture()
    case = {"name": "bench", "command": args.cmd}
    snap = parity.default_snapshot()
    res = {"stock": [], "cand": []}
    cpu = {"stock": 0.0, "cand": 0.0}
    for i in range(args.n + 3):
        for tag, shell in (("stock", args.stock), ("cand", args.candidate)):
            r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
            r = parity.run_once(shell, dict(case, settle_ms=0, block=True), snap, env, tag)
            r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
            if i >= 3:  # warm-up: the first candidate calls start the daemon
                res[tag].append(r["wall_ms"])
                cpu[tag] += (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)
            time.sleep(args.gap_ms / 1000)
    print(
        "load %s  n=%d  gap=%d ms  cmd=%r"
        % (os.getloadavg()[0], args.n, args.gap_ms, args.cmd)
    )
    for tag in ("stock", "cand"):
        v = res[tag]
        print(
            "%-6s p50 %6.2f  p90 %6.2f  min %6.2f  mean %6.2f ms   direct-child cpu %.2f ms/call"
            % (
                tag,
                statistics.median(v),
                pct(v, 0.9),
                min(v),
                statistics.mean(v),
                cpu[tag] * 1000 / len(v),
            )
        )


if __name__ == "__main__":
    main()
