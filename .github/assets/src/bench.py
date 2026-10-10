# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["fonttools>=4.55", "brotli>=1.1", "uharfbuzz>=0.45"]
# ///
"""
Benchmark charts for the README, from pod-bench's summary.json (bench/summarize.mjs).

    uv run .github/assets/src/bench.py                       # latest bench/results/<date>/summary.json
    uv run .github/assets/src/bench.py --results path/to/summary.json
    uv run .github/assets/src/bench.py --fixture --out /tmp/charts   # layout test, FAKE data

Every figure drawn comes from summary.json as written: medians, p95s, n,
hardware, date, conditions and the comparisons' factors. Nothing is computed
here except the axis. With no results yet it draws a card that says so and
shows no number. A summary marked "fixture" is watermarked FAKE on every chart
and can't be written into .github/assets.

With --readme it also rewrites the blocks between <!-- bench:start --> and
<!-- bench:end -->, and <!-- bench:claude-acc:start --> and its end, in
.github/README.md: the charts and a table of every number. The claude-acc
suite goes to its own section; its historical rows (provenance.kind
"historical") are hatched and dated, apart from fresh measurements.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from house import (
    THEMES,
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    face,
    n,
    oklch,
    ring,
    squircle,
    wrap,
)

ASSETS = Path(__file__).resolve().parent.parent
REPO = ASSETS.parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "FAKE-summary.json"
METHODOLOGY = "../bench/README.md"
SUITE_NAMES = {
    "latency": "Latency",
    "throughput": "Terminal throughput",
    "throughput-visible": "Terminal throughput, visible windows",
    "search": "Code search",
    "startup": "Startup",
    "panes": "Many panes",
    "polling": "Idle polling",
    "git-status": "Git status",
    "memory": "Memory",
    "idle-cpu": "Idle CPU",
    "claude-acc": "claude-acc",
}


def suite_label(summary: dict, suite: str) -> str:
    """The suite's name (polling-ptys80 is polling under another condition), plus the condition pod-bench labels it with."""
    key = suite if suite in SUITE_NAMES else max((k for k in SUITE_NAMES if suite.startswith(k)), key=len, default=suite)
    name = SUITE_NAMES.get(key, suite)
    condition = (summary.get("suites", {}).get(suite) or {}).get("condition")
    return f"{name} · {condition}" if condition else name


def fmt(v: float | None) -> str:
    """Three significant figures, thousands separated: presentation only; the table keeps every digit."""
    if v is None:
        return "–"
    if abs(v) >= 100:
        return f"{v:,.0f}"
    return f"{v:.3g}"


def nice_ticks(hi: float, count: int = 5) -> list[float]:
    if hi <= 0:
        return [0, 1]
    raw = hi / count
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return [i * step for i in range(int(math.ceil(hi / step)) + 1)]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48]


def groups(summary: dict) -> list[dict]:
    """One chart per suite and metric, its rows in summary order."""
    out: dict[tuple[str, str], dict] = {}
    coming = {c.get("id") for c in summary.get("coming", [])}
    for m in summary.get("metrics", []):
        if m.get("median") is None or is_acc(m) or m["id"] in coming:
            continue
        key = (m["suite"], m["metric"])
        g = out.setdefault(
            key,
            {
                "suite": m["suite"],
                "metric": m["metric"],
                "unit": m["unit"],
                "better": m.get("better", "lower"),
                "rows": [],
            },
        )
        g["rows"].append(m)
    for g in out.values():
        g["comparisons"] = [
            c
            for c in summary.get("comparisons", [])
            if c["metric"] == g["metric"]
            and any(r["id"] == c["candidate"]["id"] for r in g["rows"])
        ]
        g["conditions"] = sorted(
            {r["conditions"] for r in g["rows"] if r.get("conditions")}
        )
        g["caveats"] = list(dict.fromkeys(c for r in g["rows"] for c in r.get("caveats", [])))
    return list(out.values())


def provenance(r: dict) -> dict | None:
    """A historical row's {date, source, note}: measured before this run (claude-acc's own numbers); None when fresh."""
    p = r.get("provenance")
    if isinstance(p, str):
        p = {"kind": p}
    if isinstance(p, dict) and p.get("kind") == "historical":
        return p
    return None


def is_pod(subject: str) -> bool:
    return "pod" in subject.lower()


def _ground(theme: Theme) -> Ink:
    return Ink("#000000") if theme.dark else Ink(oklch(0.985, 0.002, 91))


def chart(g: dict, summary: dict, theme: Theme, narrow: bool = False) -> Doc:
    k = 1.32 if narrow else 1.0
    W = 720 if narrow else 1280
    pad = 40 * (0.8 if narrow else 1)
    eyebrow_t = Type("suisse", 16 * k)
    title_t = Type("neue", 32 * k, 1.15, -0.02)
    sub_t = Type("suisse", 16 * k, 1.4)
    label_t = Type("suisse", 17 * k, 1.3)
    n_t = Type("suisse", 13.5 * k)
    value_t = Type("neue-medium", 17 * k)
    p95_t = Type("suisse", 14 * k)
    tick_t = Type("mono", 12.5 * k)
    foot_t = Type("suisse", 14 * k, 1.45)
    fig_t = Type("neue", 52 * k, 1.0, -0.02)
    fixture = "fixture" in summary

    rows = g["rows"]
    # On a phone the subject sits over its bar; wide, in a column to the left.
    label_w = 0 if narrow else 260
    row_h = (96 if narrow else 66) * k
    bar_h = min(22.0, 22 * k)
    head_h = pad + eyebrow_t.size + 14 + title_t.size * 1.2 + sub_t.size * 1.9
    comps = g["comparisons"]
    if narrow and comps:
        head_h += fig_t.size * 1.6
    plot_top = head_h + 18
    plot_h = len(rows) * row_h
    axis_h = 34 * k
    foot_lines: list[tuple[str, Ink]] = []
    meta = f"{summary.get('hardware', 'hardware not recorded')} · {summary.get('resultsDir', '').split('/')[-1] or summary.get('generatedAt', '')[:10]}"
    text_w = W - 2 * pad
    for line in wrap(meta, foot_t, text_w):
        foot_lines.append((line, theme.ink2))
    for c in g["conditions"]:
        for line in wrap(f"Conditions: {c}", foot_t, text_w):
            foot_lines.append((line, theme.ink3))
    for c in g["comparisons"][1:]:
        verdict = "ahead" if c.get("candidateAhead", c["factor"] > 1) else "behind"
        line = f"{c['candidate']['subject']} vs {c['baseline']['subject']}: {c['factor']:.3g}×, {verdict} (medians)"
        for part in wrap(line, foot_t, text_w):
            foot_lines.append((part, theme.ink2))
    for r in g["rows"]:
        p = provenance(r)
        if p:
            note = f"Historical: {r['subject']}, measured {p.get('date', 'on an earlier date')}" + (f", {p['source']}" if p.get("source") else "") + (f". {p['note']}" if p.get("note") else "")
            for part in wrap(note, foot_t, text_w):
                foot_lines.append((part, theme.ink2))
    for c in [*g["caveats"], *summary.get("caveats", [])]:
        for line in wrap(f"Caveat: {c}", foot_t, text_w):
            foot_lines.append((line, theme.ink2))
    foot_lines.append(("Methodology: bench/README.md", theme.ink3))
    H = (
        plot_top
        + plot_h
        + axis_h
        + 24
        + len(foot_lines) * foot_t.size * foot_t.leading
        + pad
    )
    title = f"{suite_label(summary, g['suite'])}: {g['metric']}" + (
        " (FAKE fixture data)" if fixture else ""
    )
    doc = Doc(W, H, title)
    panel = squircle(0.5, 0.5, W - 1, H - 1, 28)
    doc.add(f'<path d="{panel}" {_ground(theme).fill()}/>')
    doc.add(ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong))

    # Head
    y = pad + eyebrow_t.size * 0.8
    doc.text(pad, y, suite_label(summary, g["suite"]), eyebrow_t, theme.pod_ink)
    y += 14 + title_t.size
    doc.text(pad, y, g["metric"][:1].upper() + g["metric"][1:], title_t, theme.ink)
    y += sub_t.size * 1.6
    better = "lower is better" if g["better"] != "higher" else "higher is better"
    doc.text(
        pad, y, f"Median bar, p95 whisker, in {g['unit']} · {better}", sub_t, theme.ink3
    )
    if comps:
        # The first comparison leads; the others are listed in the foot.
        c = comps[0]
        ahead = c.get("candidateAhead", c["factor"] > 1)
        fig = f"{c['factor']:.3g}×"
        cap = f"{c['candidate']['subject']} vs {c['baseline']['subject']}, medians"
        verdict = "ahead" if ahead else "behind"
        if narrow:
            fy = y + fig_t.size * 1.25
            doc.text(pad, fy, fig, fig_t, theme.ink)
            fw = face(fig_t.face).width(fig, fig_t.size, fig_t.tracking)
            doc.text(pad + fw + 16, fy - fig_t.size * 0.45, verdict, sub_t, theme.ink2)
            doc.text(pad + fw + 16, fy, cap, Type("suisse", 13 * k), theme.ink3)
        else:
            doc.text(
                W - pad, pad + fig_t.size * 0.85, fig, fig_t, theme.ink, anchor="end"
            )
            doc.text(
                W - pad,
                pad + fig_t.size * 0.85 + sub_t.size * 1.7,
                f"{verdict}: {cap}",
                sub_t,
                theme.ink3,
                anchor="end",
            )

    # Plot
    x0, x1 = pad + label_w, W - pad - (150 if not narrow else 120) * k
    hi = max(max(r["p95"] or r["median"], r["median"]) for r in rows)
    ticks = nice_ticks(hi, 3 if narrow else 5)
    top_tick = ticks[-1]
    sx = lambda v: x0 + (x1 - x0) * v / top_tick
    for t in ticks:
        gx = sx(t)
        doc.add(
            f'<path d="M{n(gx)} {n(plot_top)}V{n(plot_top + plot_h)}" {theme.chart_grid.stroke()}/>'
        )
        doc.text(
            gx, plot_top + plot_h + 22 * k, fmt(t), tick_t, theme.ink3, anchor="middle"
        )
    lead_ids = {c["candidate"]["id"] for c in comps}
    for i, r in enumerate(rows):
        cy = plot_top + i * row_h + row_h / 2
        hist = provenance(r)
        meta_line = (f"n = {r['n']:,}" if r.get("n") else "n not recorded") + (f" · historical, {hist.get('date', 'earlier')}" if hist else "")
        if narrow:
            lw = doc.text(pad, cy - bar_h / 2 - 12 * k, r["subject"], label_t, theme.ink)
            doc.text(pad + lw + 10, cy - bar_h / 2 - 12 * k, meta_line, n_t, theme.ink3)
            cy += 8 * k
        else:
            doc.text(pad, cy - 2, r["subject"], label_t, theme.ink)
            doc.text(pad, cy + n_t.size * 1.3, meta_line, n_t, theme.ink3)
        w = max(2.0, sx(r["median"]) - x0)
        # Emphasis, not a palette: the comparison's candidate (else every Pod row) in Pod's hue, the rest grey.
        lit = r["id"] in lead_ids if lead_ids else is_pod(r["subject"])
        fill = theme.pod_glyph if lit else theme.chart_muted
        rr = 4
        bar = (
            f"M{n(x0)} {n(cy - bar_h / 2)}H{n(x0 + w - rr)}Q{n(x0 + w)} {n(cy - bar_h / 2)} {n(x0 + w)} {n(cy - bar_h / 2 + rr)}"
            f"V{n(cy + bar_h / 2 - rr)}Q{n(x0 + w)} {n(cy + bar_h / 2)} {n(x0 + w - rr)} {n(cy + bar_h / 2)}H{n(x0)}Z"
        )
        if hist:
            # Historical: the same hue, hatched at 45 degrees and outlined, never solid like a fresh number.
            pid = doc.define(
                f"hatch-{fill.hex[1:]}",
                f'<pattern id="hatch-{fill.hex[1:]}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
                f'<path d="M0 0V6" {fill.stroke()} stroke-width="2"/></pattern>',
            )
            doc.add(f'<path d="{bar}" fill="url(#{pid})" {fill.stroke()} stroke-width="1.5"/>')
        else:
            doc.add(f'<path d="{bar}" {fill.fill()}/>')
        end = x0 + w
        if r.get("p95") is not None and r["p95"] > r["median"]:
            px = sx(r["p95"])
            doc.add(
                f'<path d="M{n(end)} {n(cy)}H{n(px)}M{n(px)} {n(cy - 7)}V{n(cy + 7)}" fill="none" {theme.ink3.stroke()} stroke-width="1.5" stroke-linecap="round"/>'
            )
            end = px
        vx = end + 12
        vw = doc.text(
            vx,
            cy + cap_middle(value_t) - 6 * k,
            f"{fmt(r['median'])} {g['unit']}",
            value_t,
            theme.ink,
        )
        if r.get("p95") is not None:
            doc.text(
                vx,
                cy + cap_middle(value_t) + 14 * k,
                f"p95 {fmt(r['p95'])}",
                p95_t,
                theme.ink3,
            )
        del vw
    doc.add(
        f'<path d="M{n(x0)} {n(plot_top - 6)}V{n(plot_top + plot_h)}" {theme.hairline_strong.stroke()}/>'
    )

    # Foot
    fy = plot_top + plot_h + axis_h + 24 + foot_t.size
    for line, ink in foot_lines:
        doc.text(pad, fy, line, foot_t, ink)
        fy += foot_t.size * foot_t.leading

    if fixture:
        warn = Ink(oklch(0.66, 0.18, 28))
        doc.add(f'<g opacity=".9" transform="rotate(-14 {n(W / 2)} {n(H / 2)})">')
        words = "FAKE FIXTURE · NOT A MEASUREMENT"
        mark_t = Type("neue-medium", 64 * W * 0.9 / face("neue-medium").width(words, 64, 0.02), tracking=0.02)
        doc.text(
            W / 2,
            H / 2 + 20,
            "FAKE FIXTURE · NOT A MEASUREMENT",
            mark_t,
            warn.with_a(0.55),
            anchor="middle",
        )
        doc.add("</g>")
    return doc


ACC_PHASES = ("before", "after")
# The user's own Claude Code notes are not a public source: such rows never reach the README.
PRIVATE_SOURCE = re.compile(r"project memory|\.claude/", re.IGNORECASE)


def private_source(m: dict) -> bool:
    p = m.get("provenance") or {}
    return bool(PRIVATE_SOURCE.search(str(p.get("source") or "")))


def is_acc(m: dict) -> bool:
    return m.get("group", m.get("suite")) == "claude-acc"


def acc_items(summary: dict) -> list[dict]:
    """claude-acc's rows as items (id minus .historical and .before/.after), in summary order; area is the metric's prefix."""
    comps = {c["candidate"]["id"]: c for c in summary.get("comparisons", [])}
    items: dict[str, dict] = {}
    dropped = [m["id"] for m in summary.get("metrics", []) if is_acc(m) and private_source(m)]
    dropped += [c.get("id") for c in summary.get("coming", [])]
    if dropped:
        print(f"claude-acc: left out {len(dropped)} rows sourced from private notes: {', '.join(dropped)}", file=sys.stderr)
    for m in summary.get("metrics", []):
        if not is_acc(m) or m["id"] in dropped:
            continue
        note = str((m.get("extra") or {}).get("note") or "")
        if PRIVATE_SOURCE.search(note):
            raise SystemExit(f"{m['id']}: its note cites private notes ({note!r}); fix it in pod-bench")
        parts = m["id"].split(".")
        phase = parts[-1] if parts[-1] in ACC_PHASES else None
        key = ".".join(p for p in parts[1:] if p != "historical" and p not in ACC_PHASES)
        area, _, what = m["metric"].partition(": ")
        if not what:
            area, what = SUITE_NAMES["claude-acc"], m["metric"]
        it = items.setdefault(
            key,
            {"key": key, "area": area, "what": what, "metric": m["metric"], "unit": m["unit"],
             "better": m.get("better", "lower"), "rows": [], "comparisons": []},
        )
        it["rows"].append({**m, "phase": phase})
        if m["id"] in comps and comps[m["id"]]["baseline"]["id"] not in dropped:
            it["comparisons"].append(comps[m["id"]])
    for it in items.values():
        # Fresh rows first, then historical; before above after.
        it["rows"].sort(key=lambda r: (provenance(r) is not None, ACC_PHASES.index(r["phase"]) if r["phase"] else 2))
        it["comparisons"].sort(key=lambda c: (c.get("provenance") or {}).get("kind") == "historical")
        it["context"] = any((r.get("extra") or {}).get("role") == "context" for r in it["rows"])
    return list(items.values())


def acc_areas(items: list[dict]) -> list[tuple[str, list[dict]]]:
    out: dict[str, list[dict]] = {}
    for it in items:
        out.setdefault(it["area"], []).append(it)
    return list(out.items())


def value_label(r: dict, unit: str) -> str:
    if r.get("median") is None:
        return f"{fmt(r.get('min'))}–{fmt(r.get('max'))} {unit}"
    return f"{fmt(r['median'])} {unit}"


def factor_label(c: dict, better: str) -> str:
    if c.get("candidateAhead", c["factor"] > 1):
        return f"{c['factor']:.3g}× {'higher' if better == 'higher' else 'lower'}"
    return f"{c['factor']:.3g}×, behind"


def rich_words(s: str) -> list[list[tuple[str, bool]]]:
    """Words of a string whose `code spans` are set in mono: each word as (text, is_code) pieces."""
    words, code = [], False
    for raw in s.split(" "):
        pieces = []
        for j, p in enumerate(raw.split("`")):
            if j:
                code = not code
            if p:
                pieces.append((p, code))
        if pieces:
            words.append(pieces)
    return words


def _rich_type(t: Type, mono: Type, code: bool) -> Type:
    return mono if code else t


def rich_wrap(s: str, t: Type, mono: Type, max_w: float) -> list[list[list[tuple[str, bool]]]]:
    space = face(t.face).width(" ", t.size, t.tracking)
    width = lambda word: sum(
        face(_rich_type(t, mono, c).face).width(p, _rich_type(t, mono, c).size, _rich_type(t, mono, c).tracking)
        for p, c in word
    )
    lines: list = []
    line: list = []
    w = 0.0
    for word in rich_words(s):
        ww = width(word)
        if line and w + space + ww > max_w:
            lines.append(line)
            line, w = [], 0.0
        w += (space if line else 0) + ww
        line.append(word)
    if line:
        lines.append(line)
    return lines


def rich_line(doc: Doc, x: float, y: float, line: list, t: Type, mono: Type, ink: Ink) -> float:
    space = face(t.face).width(" ", t.size, t.tracking)
    for i, word in enumerate(line):
        if i:
            x += space
        for p, c in word:
            x += doc.text(x, y, p, _rich_type(t, mono, c), ink)
    return x


def acc_chart(area: str, items: list[dict], summary: dict, theme: Theme, narrow: bool = False) -> Doc:
    """One claude-acc area. Each item gets its own zero-based scale, since units differ; factors are summary.json's."""
    k = 1.32 if narrow else 1.0
    W = 720 if narrow else 1280
    pad = 40 * (0.8 if narrow else 1)
    eyebrow_t = Type("suisse", 16 * k)
    title_t = Type("neue", 32 * k, 1.15, -0.02)
    sub_t = Type("suisse", 16 * k, 1.4)
    what_t = Type("neue-medium", 18 * k, 1.3)
    fig_t = Type("neue-medium", 18 * k)
    subj_t = Type("suisse", 15 * k, 1.3)
    what_mono = Type("mono-medium", 16.5 * k)
    subj_mono = Type("mono", 13.8 * k)
    value_t = Type("neue-medium", 15 * k)
    meta_t = Type("suisse", 13.5 * k, 1.4)
    foot_t = Type("suisse", 14 * k, 1.45)
    fixture = "fixture" in summary
    text_w = W - 2 * pad
    subj_w = 0 if narrow else 360
    x0 = pad + subj_w + (0 if narrow else 24)
    x1 = W - pad - 200 * k
    bar_h = 14 * k
    title = f"claude-acc, {area}" + (" (FAKE fixture data)" if fixture else "")
    doc = Doc(W, 0, title)
    y = pad + eyebrow_t.size * 0.8
    doc.text(pad, y, "claude-acc · measured", eyebrow_t, theme.pod_ink)
    y += 14 + title_t.size
    doc.text(pad, y, area, title_t, theme.ink)
    y += sub_t.size * 1.6
    hatched = any(provenance(r) for it in items for r in it["rows"])
    sub = "Each item on its own scale from zero" + (" · hatched: historical" if hatched else "")
    for line in wrap(sub, sub_t, text_w):
        doc.text(pad, y, line, sub_t, theme.ink3)
        y += sub_t.size * sub_t.leading

    for i, it in enumerate(items):
        if i:
            doc.add(f'<path d="M{n(pad)} {n(y)}H{n(W - pad)}" {theme.hairline.stroke()}/>')
        y += 26 * k
        comps = it["comparisons"]
        fig = "Context, not a win" if it["context"] else (factor_label(comps[0], it["better"]) if comps else "")
        fig_ink = theme.ink3 if it["context"] else theme.ink
        fw = face(fig_t.face).width(fig, fig_t.size, fig_t.tracking) if fig else 0
        # As summary.json writes it: no case change, since items start with names like rtk or `git status`.
        what_rows = rich_wrap(it["what"], what_t, what_mono, text_w - fw - 24 * k)
        y += what_t.size * 0.8
        if fig:
            doc.text(W - pad, y, fig, fig_t, fig_ink, anchor="end")
        for j, line in enumerate(what_rows):
            if j:
                y += what_t.size * what_t.leading
            rich_line(doc, pad, y, line, what_t, what_mono, theme.ink)
        y += 12 * k
        hi = max((r["median"] if r.get("median") is not None else r.get("max") or 0) for r in it["rows"])
        if it["unit"].startswith("%"):
            hi = max(hi, 100)
        hi = hi or 1
        sx = lambda v: x0 + (x1 - x0) * v / hi
        lit_ids = {c["candidate"]["id"] for c in comps}
        top = y
        mixed = len({provenance(r) is None for r in it["rows"]}) > 1
        for r in it["rows"]:
            hist = provenance(r)
            subject = r["subject"]
            if mixed:
                subject += f" · {hist.get('date', 'historical')}" if hist else " · this run"
            if narrow:
                y += subj_t.size
                rich_line(doc, pad, y, [w for ln in rich_wrap(subject, subj_t, subj_mono, 1e9) for w in ln], subj_t, subj_mono, theme.ink2)
                cy = y + 8 * k + bar_h / 2
                y = cy + bar_h / 2 + 12 * k
            else:
                rows_s = rich_wrap(subject, subj_t, subj_mono, subj_w)
                cy = y + 4 * k + bar_h / 2
                for j, line in enumerate(rows_s):
                    rich_line(doc, pad, cy + cap_middle(subj_t) + j * subj_t.size * subj_t.leading, line, subj_t, subj_mono, theme.ink2)
                y += max(bar_h + 16 * k, len(rows_s) * subj_t.size * subj_t.leading + 8 * k)
            lit = not it["context"] and (r["id"] in lit_ids if lit_ids else r["phase"] == "after")
            fill = theme.pod_glyph if lit else theme.chart_muted
            if r.get("median") is None:
                a, b = sx(r.get("min") or 0), sx(r.get("max") or 0)
            else:
                a, b = x0, sx(r["median"])
            b = max(b, a + 2)
            rr = min(4.0, (b - a) / 2)
            ra = rr if r.get("median") is None else 0
            bar = (
                f"M{n(a + ra)} {n(cy - bar_h / 2)}H{n(b - rr)}Q{n(b)} {n(cy - bar_h / 2)} {n(b)} {n(cy - bar_h / 2 + rr)}"
                f"V{n(cy + bar_h / 2 - rr)}Q{n(b)} {n(cy + bar_h / 2)} {n(b - rr)} {n(cy + bar_h / 2)}H{n(a + ra)}"
                + (f"Q{n(a)} {n(cy + bar_h / 2)} {n(a)} {n(cy + bar_h / 2 - ra)}V{n(cy - bar_h / 2 + ra)}Q{n(a)} {n(cy - bar_h / 2)} {n(a + ra)} {n(cy - bar_h / 2)}" if ra else "")
                + "Z"
            )
            if hist:
                pid = doc.define(
                    f"hatch-{fill.hex[1:]}",
                    f'<pattern id="hatch-{fill.hex[1:]}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
                    f'<path d="M0 0V6" {fill.stroke()} stroke-width="2"/></pattern>',
                )
                doc.add(f'<path d="{bar}" fill="url(#{pid})" {fill.stroke()} stroke-width="1.5"/>')
            else:
                doc.add(f'<path d="{bar}" {fill.fill()}/>')
            doc.text(b + 10 * k, cy + cap_middle(value_t), value_label(r, it["unit"]), value_t, theme.ink)
        doc.add(f'<path d="M{n(x0)} {n(top - 2)}V{n(y - 8 * k)}" {theme.hairline_strong.stroke()}/>')
        # Provenance and the source's own notes, as written.
        when = sorted({(provenance(r) or {}).get("date") or "" for r in it["rows"] if provenance(r)})
        fresh = [r for r in it["rows"] if not provenance(r)]
        bits = []
        if fresh:
            ns = sorted({r["n"] for r in fresh if r.get("n")})
            bits.append("this run" + (f", n = {', '.join(f'{v:,}' for v in ns)}" if ns else ""))
        if when:
            bits.append(f"historical, measured {', '.join(when)}")
        for r in it["rows"]:
            note = (r.get("extra") or {}).get("note")
            if note:
                bits.append(f"{r['phase'] or 'note'}: {note}" if len(it["rows"]) > 1 else note)
        for c in comps[1:]:
            bits.append(f"{'historical ' if provenance(c) else ''}{factor_label(c, it['better'])}")
        meta = " · ".join(bits)
        meta = meta[:1].upper() + meta[1:]
        y += meta_t.size * 0.4
        y = doc.lines(pad, y + meta_t.size, wrap(meta, meta_t, text_w), meta_t, theme.ink3) + 22 * k

    # Foot
    y += 10 * k
    doc.add(f'<path d="M{n(pad)} {n(y)}H{n(W - pad)}" {theme.hairline_strong.stroke()}/>')
    y += 16 * k + foot_t.size
    foot = [f"{summary.get('hardware', 'hardware not recorded')}"]
    if hatched:
        foot.append("Hatched: measured before this run, on the date shown. Every source is in the table below.")
    for c in dict.fromkeys(c for it in items for r in it["rows"] for c in r.get("caveats", [])):
        foot.append(f"Caveat: {c}")
    foot.append("Methodology: bench/README.md in outof-place/pod.")
    for part in foot:
        for line in wrap(part, foot_t, text_w):
            doc.text(pad, y, line, foot_t, theme.ink2 if not line.startswith("Methodology") else theme.ink3)
            y += foot_t.size * foot_t.leading
    H = y - foot_t.size * foot_t.leading + pad + 6
    doc.h = H
    panel = squircle(0.5, 0.5, W - 1, H - 1, 28)
    doc.body[:0] = [f'<path d="{panel}" {_ground(theme).fill()}/>', ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong)]
    if fixture:
        warn = Ink(oklch(0.66, 0.18, 28))
        doc.add(f'<g opacity=".9" transform="rotate(-14 {n(W / 2)} {n(H / 2)})">')
        words = "FAKE FIXTURE · NOT A MEASUREMENT"
        mark_t = Type("neue-medium", 64 * W * 0.9 / face("neue-medium").width(words, 64, 0.02), tracking=0.02)
        doc.text(W / 2, H / 2 + 20, words, mark_t, warn.with_a(0.55), anchor="middle")
        doc.add("</g>")
    return doc


def pending(theme: Theme, narrow: bool = False) -> Doc:
    """The card the README shows until pod-bench publishes: what is measured, and no number."""
    k = 1.3 if narrow else 1.0
    W = 720 if narrow else 1280
    pad = 40 * (0.8 if narrow else 1)
    eyebrow_t = Type("suisse", 16 * k)
    title_t = Type("neue", 40 * k, 1.12, -0.022)
    body_t = Type("suisse", 20 * k, 1.45)
    item_t = Type("neue-medium", 18 * k)
    suites = [
        "Keystroke to pixels",
        "Terminal throughput",
        "Code search vs ripgrep",
        "Startup",
        "Many panes",
        "Idle polling",
        "Git status",
    ]
    cols = 2 if narrow else 4
    rows_n = (len(suites) + cols - 1) // cols
    lead = (
        "Pod's numbers come from pod-bench: every run records n, the median and p95, the machine and the "
        "date. They appear here as soon as the first run is published, and not before."
    )
    lead_rows = wrap(lead, body_t, W - 2 * pad)
    H = (
        pad
        + eyebrow_t.size
        + 16
        + title_t.size * 2.3
        + len(lead_rows) * body_t.size * body_t.leading
        + 28
        + rows_n * 52 * k
        + pad
    )
    doc = Doc(
        W,
        H,
        "Benchmarks: being measured. No numbers until pod-bench publishes its first run.",
    )
    doc.style(
        "@keyframes blink{50%{opacity:.25}}.blink{animation:blink 1.6s cubic-bezier(0.65,0,0.35,1) infinite}"
    )
    panel = squircle(0.5, 0.5, W - 1, H - 1, 28)
    doc.add(f'<path d="{panel}" {_ground(theme).fill()}/>')
    doc.add(ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong))
    y = pad + eyebrow_t.size * 0.8
    doc.add(
        f'<circle class="blink" cx="{n(pad + 5)}" cy="{n(y - cap_middle(eyebrow_t))}" r="{4 * k:g}" {theme.pod_glyph.fill()}/>'
    )
    doc.text(pad + 18 * k, y, "Benchmarks", eyebrow_t, theme.pod_ink)
    y += 16 + title_t.size
    doc.text(pad, y, "Being measured.", title_t, theme.ink)
    y += title_t.size * title_t.leading
    doc.text(pad, y, "Numbers, not adjectives.", title_t, theme.ink3)
    y += title_t.size * 0.9 + body_t.size
    y = doc.lines(pad, y, lead_rows, body_t, theme.ink2) + 28
    cw = (W - 2 * pad) / cols
    for i, s in enumerate(suites):
        cx, cy = pad + (i % cols) * cw, y + (i // cols) * 52 * k
        doc.add(
            f'<path d="M{n(cx)} {n(cy)}h{n(cw - 20)}" {theme.hairline_strong.stroke()}/>'
        )
        doc.text(cx, cy + 32 * k, s, item_t, theme.ink)
    return doc


def find_summary(results: Path | None) -> Path | None:
    root = results or (REPO / "bench" / "results")
    if root.is_file():
        return root
    if not root.is_dir():
        return None
    dated = sorted(p for p in root.glob("*/summary.json"))
    return dated[-1] if dated else None


ACC_PENDING = (
    "<sub>claude-acc's numbers come from pod-bench's claude-acc group. Fresh runs are drawn solid; "
    "figures measured before Pod are hatched and carry their date and source. Being collected.</sub>\n"
)


def methodology_url(summary: dict | None) -> str:
    m = (summary or {}).get("methodology")
    return m.get("url", METHODOLOGY) if isinstance(m, dict) else METHODOLOGY


def acc_readme_block(charts: list[tuple[str, str, list[dict]]], summary: dict, prefix: str) -> str:
    out = []
    for name, area, items in charts:
        alt = f"claude-acc, {area}, each item on its own scale. " + " ".join(
            f"{it['what'].replace('`', '')}: "
            + ", ".join(
                f"{r['subject'].replace('`', '')} {value_label(r, it['unit'])}"
                + (f" (historical, {provenance(r).get('date')})" if provenance(r) else "")
                for r in it["rows"]
            )
            + (f"; {factor_label(it['comparisons'][0], it['better'])}." if it["comparisons"] and not it["context"] else ".")
            for it in items
        )
        out.append(
            "<picture>\n"
            f'  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="{prefix}{name}-narrow-dark.svg">\n'
            f'  <source media="(max-width: 600px)" srcset="{prefix}{name}-narrow-light.svg">\n'
            f'  <source media="(prefers-color-scheme: dark)" srcset="{prefix}{name}-dark.svg">\n'
            f'  <img alt="{escape_attr(alt)}" src="{prefix}{name}-light.svg" width="100%">\n'
            "</picture>\n"
        )
    rows = [
        "| Item | Subject | Median | Min | Max | n | Measured | Note |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for _, _, items in charts:
        for it in items:
            for r in it["rows"]:
                p = provenance(r)
                when = "this run" if not p else f"historical, {p.get('date', 'earlier')}" + (f": {p['source']}" if p.get("source") else "")
                note = (r.get("extra") or {}).get("note") or ""
                if (r.get("extra") or {}).get("role") == "context":
                    note = "context, not a win" + (f"; {note}" if note else "")
                cells = [it["metric"], r["subject"], cell(r.get("median"), it["unit"]), cell(r.get("min"), it["unit"]),
                         cell(r.get("max"), it["unit"]), cell(r.get("n")), when, note]
                rows.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
    date = summary.get("resultsDir", "").split("/")[-1] or summary.get("generatedAt", "")[:10]
    caveats = [*summary.get("caveats", []), *summary.get("suites", {}).get("claude-acc", {}).get("caveats", [])]
    out.append(
        "\n<details>\n<summary>Every claude-acc number, with its date and source</summary>\n\n"
        + "\n".join(rows)
        + f"\n\nFrom `bench/{summary.get('resultsDir', 'results')}/summary.json`, {date}, on {summary.get('hardware', 'unrecorded hardware')}. "
        + f"How it is measured: [bench/README.md]({methodology_url(summary)}).\n"
        + "".join(f"\n- Caveat: {c}" for c in dict.fromkeys(caveats))
        + "\n\n</details>\n"
    )
    return "\n".join(out) + coming_block(summary, acc=True)


def cell(v: float | int | None, unit: str = "") -> str:
    """Every digit as written, for the table."""
    if v is None:
        return "–"
    return f"{v:,}" + (f" {unit}" if unit else "") if isinstance(v, int) else f"{v:g}" + (f" {unit}" if unit else "")


def escape_attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def readme_block(
    charts: list[tuple[str, dict]], summary: dict | None, prefix: str
) -> str:
    if not summary:
        return (
            "<picture>\n"
            f'  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="{prefix}bench-pending-narrow-dark.svg">\n'
            f'  <source media="(max-width: 600px)" srcset="{prefix}bench-pending-narrow-light.svg">\n'
            f'  <source media="(prefers-color-scheme: dark)" srcset="{prefix}bench-pending-dark.svg">\n'
            f'  <img alt="Benchmarks are being measured. No numbers are shown until pod-bench publishes its first run." src="{prefix}bench-pending-light.svg" width="100%">\n'
            "</picture>\n"
        )
    out = []
    for name, g in charts:
        alt = f"{suite_label(summary, g['suite'])}: {g['metric']}. " + "; ".join(
            f"{r['subject']} median {fmt(r['median'])} {g['unit']}, p95 {fmt(r['p95'])}, n {r['n']}"
            for r in g["rows"]
        )
        out.append(
            "<picture>\n"
            f'  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="{prefix}{name}-narrow-dark.svg">\n'
            f'  <source media="(max-width: 600px)" srcset="{prefix}{name}-narrow-light.svg">\n'
            f'  <source media="(prefers-color-scheme: dark)" srcset="{prefix}{name}-dark.svg">\n'
            f'  <img alt="{alt}" src="{prefix}{name}-light.svg" width="100%">\n'
            "</picture>\n"
        )
    rows = [
        "| Benchmark | Subject | Median | p95 | n | Min | Max | Measured |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for _, g in charts:
        for r in g["rows"]:
            p = provenance(r)
            when = "this run" if not p else f"historical, {p.get('date', 'earlier')}" + (f" ({p['source']})" if p.get("source") else "")
            rows.append(
                f"| {suite_label(summary, g['suite'])}: {g['metric']} | {r['subject']} | {r['median']} {g['unit']} | {r['p95']} | {r['n']} | {r.get('min')} | {r.get('max')} | {when} |"
            )
    date = (
        summary.get("resultsDir", "").split("/")[-1]
        or summary.get("generatedAt", "")[:10]
    )
    out.append(
        "\n<details>\n<summary>Every number, as measured</summary>\n\n"
        + "\n".join(rows)
        + f"\n\nMeasured on {summary.get('hardware', 'unrecorded hardware')}, {date}. "
        + f"Source: `{summary.get('resultsDir', 'bench/results')}/summary.json`. "
        + f"How it is measured: [bench/README.md]({methodology_url(summary)}).\n"
        + "".join(f"\n- Caveat: {c}" for c in summary.get("caveats", []))
        + "\n\n</details>\n"
    )
    return "\n".join(out) + coming_block(summary, acc=False)


def coming_block(summary: dict, acc: bool) -> str:
    """Rows the run could not measure (summary.json's `coming`): named, with pod-bench's reason, and never a number."""
    entries = [c for c in summary.get("coming", []) if (c.get("suite") == "claude-acc") == acc]
    if not entries:
        return ""
    return "\n**Coming**, not measured in this run:\n\n" + "".join(
        f"- {suite_label(summary, c.get('suite', ''))}: {c.get('subject', c.get('id'))}. {c['reason']}\n"
        if c.get("reason")
        else f"- {suite_label(summary, c.get('suite', ''))}: {c.get('subject', c.get('id'))}.\n"
        for c in entries
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--results",
        type=Path,
        help="a summary.json, or a results dir holding <date>/summary.json",
    )
    ap.add_argument(
        "--fixture",
        action="store_true",
        help="draw the FAKE fixture (layout test only)",
    )
    ap.add_argument("--out", type=Path, default=ASSETS)
    ap.add_argument(
        "--readme",
        action="store_true",
        help="rewrite the bench block in .github/README.md",
    )
    args = ap.parse_args()
    path = FIXTURE if args.fixture else find_summary(args.results)
    summary = json.loads(path.read_text()) if path else None
    out = args.out.resolve()
    if summary and "fixture" in summary and (out == ASSETS or ASSETS in out.parents):
        raise SystemExit(
            "refusing to write FAKE fixture charts into .github/assets; pass --out to a scratch dir"
        )
    out.mkdir(parents=True, exist_ok=True)
    charts: list[tuple[str, dict]] = []
    acc_charts: list[tuple[str, str, list[dict]]] = []
    if summary:
        for g in groups(summary):
            name = f"bench-{g['suite']}-{slug(g['metric'])}"
            for t in THEMES:
                chart(g, summary, t).save(out / f"{name}-{t.name}.svg")
                chart(g, summary, t, narrow=True).save(
                    out / f"{name}-narrow-{t.name}.svg"
                )
            charts.append((name, g))
            print(f"{name}: {len(g['rows'])} rows")
        for area, items in acc_areas(acc_items(summary)):
            name = f"bench-acc-{slug(area)}"
            for t in THEMES:
                acc_chart(area, items, summary, t).save(out / f"{name}-{t.name}.svg")
                acc_chart(area, items, summary, t, narrow=True).save(out / f"{name}-narrow-{t.name}.svg")
            acc_charts.append((name, area, items))
            print(f"{name}: {len(items)} items")
    if not charts:
        for t in THEMES:
            pending(t).save(out / f"bench-pending-{t.name}.svg")
            pending(t, narrow=True).save(out / f"bench-pending-narrow-{t.name}.svg")
        print("no Pod rows yet: wrote the pending card")
    if args.readme:
        if summary and "fixture" in summary:
            raise SystemExit("refusing to put FAKE fixture data into the README")
        readme = REPO / ".github" / "README.md"
        text = readme.read_text()
        block = readme_block(charts, summary if charts else None, "assets/")
        acc_block = acc_readme_block(acc_charts, summary, "assets/") if acc_charts else ACC_PENDING
        new = re.sub(
            r"(<!-- bench:start -->\n).*?(<!-- bench:end -->)",
            lambda m: m.group(1) + block + m.group(2),
            text,
            flags=re.DOTALL,
        )
        new = re.sub(
            r"(<!-- bench:claude-acc:start -->\n).*?(<!-- bench:claude-acc:end -->)",
            lambda m: m.group(1) + acc_block + m.group(2),
            new,
            flags=re.DOTALL,
        )
        readme.write_text(new)
        print("README bench blocks updated")


if __name__ == "__main__":
    main()
